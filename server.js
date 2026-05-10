const express = require('express');
const { execFile, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = Number.parseInt(process.env.PORT, 10) || 8080;
const BASE_DIR = path.join(__dirname);
const CONFIG_PATH = path.join(BASE_DIR, 'config', 'cinemas.json');
const LLM_CONFIG_PATH = path.join(BASE_DIR, 'config', 'llm.json');
const COMMAND_TIMEOUT_MS = 30000;
const AI_TIMEOUT_MS = 60000;
const COMMAND_ENV = { ...process.env, PYTHONIOENCODING: 'utf-8' };
const MAOYAN_CLI_PATH = path.join(BASE_DIR, 'skills', 'maoyan-cli', 'scripts', 'maoyan_cli.py');
const TICKET_SCRIPT_DIR = path.join(BASE_DIR, 'skills', 'maoyan-ticket-booking', 'scripts');
const SHOWS_CACHE_TTL_MS = 60 * 1000;
const SEAT_CACHE_TTL_MS = 20 * 1000;
const showsCache = new Map();
const seatCountCache = new Map();
const LLM_API_KEY_ENV_NAMES = ['LLM_API_KEY', 'OPENAI_API_KEY'];
const DEFAULT_LLM_CONFIG = {
  provider: 'openai-compatible',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4.1-mini',
  apiKey: '',
  temperature: 0.4,
  maxTokens: 1200,
  systemPrompt: '你是一名资深影院排片分析顾问。你只能依据提供的数据进行判断，指出场次安排的合理性、潜在问题和可执行的排片建议。'
};

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(BASE_DIR, 'public')));

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
}

function loadLlmConfig() {
  try {
    if (!fs.existsSync(LLM_CONFIG_PATH)) {
      return applyLlmEnvOverrides({ ...DEFAULT_LLM_CONFIG });
    }
    const raw = JSON.parse(fs.readFileSync(LLM_CONFIG_PATH, 'utf-8'));
    return applyLlmEnvOverrides({
      ...DEFAULT_LLM_CONFIG,
      ...raw,
      baseUrl: String(raw.baseUrl || DEFAULT_LLM_CONFIG.baseUrl).trim(),
      model: String(raw.model || DEFAULT_LLM_CONFIG.model).trim(),
      apiKey: String(raw.apiKey || '').trim(),
      systemPrompt: String(raw.systemPrompt || DEFAULT_LLM_CONFIG.systemPrompt).trim()
    });
  } catch {
    return applyLlmEnvOverrides({ ...DEFAULT_LLM_CONFIG });
  }
}

function saveLlmConfig(config) {
  fs.writeFileSync(LLM_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

function getLlmApiKeyFromEnv() {
  for (const name of LLM_API_KEY_ENV_NAMES) {
    const value = process.env[name];
    if (value && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function applyLlmEnvOverrides(config) {
  const envApiKey = getLlmApiKeyFromEnv();
  if (!envApiKey) {
    return config;
  }
  return {
    ...config,
    apiKey: envApiKey
  };
}

function localDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function createCommandError(err, stderr, fallback = 'Command failed') {
  const message = (stderr || '').trim() || err?.message || fallback;
  return new Error(message);
}

function execFilePromise(command, args, timeout = COMMAND_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { encoding: 'utf-8', timeout, env: COMMAND_ENV, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          reject(createCommandError(err, stderr));
          return;
        }
        resolve(stdout);
      }
    );
  });
}

function execFileJson(command, args, timeout = COMMAND_TIMEOUT_MS) {
  return execFilePromise(command, args, timeout).then((stdout) => {
    if (!stdout || stdout.trim() === '') {
      throw new Error('No output');
    }
    try {
      return JSON.parse(stdout);
    } catch (error) {
      throw new Error(`Invalid JSON output: ${error.message}`);
    }
  });
}

function runNodeScriptJson(scriptName, input, timeout = COMMAND_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(TICKET_SCRIPT_DIR, scriptName);
    const child = spawn(process.execPath, [scriptPath], {
      env: COMMAND_ENV,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finalize = (handler) => (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      handler(value);
    };

    const resolveOnce = finalize(resolve);
    const rejectOnce = finalize(reject);

    const timer = setTimeout(() => {
      child.kill();
      rejectOnce(new Error('Command timed out'));
    }, timeout);

    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', rejectOnce);
    child.on('close', (code) => {
      if (code !== 0) {
        rejectOnce(createCommandError(null, stderr, `Command exited with code ${code}`));
        return;
      }
      if (!stdout || stdout.trim() === '') {
        rejectOnce(new Error('No output'));
        return;
      }
      try {
        resolveOnce(JSON.parse(stdout));
      } catch (error) {
        rejectOnce(new Error(`Invalid JSON output: ${error.message}`));
      }
    });

    child.stdin.end(input ? JSON.stringify(input) : '');
  });
}

async function fetchShowsForCinema(cinemaId, cityId) {
  const cacheKey = `${cinemaId}:${cityId}`;
  const cached = getCacheEntry(showsCache, cacheKey);
  if (cached) {
    return cached;
  }

  const result = await execFileJson('py', ['-3', MAOYAN_CLI_PATH, 'shows', String(cinemaId), String(cityId)]);
  setCacheEntry(showsCache, cacheKey, result, SHOWS_CACHE_TTL_MS);
  return result;
}

async function fetchSeatMapData(seqNo, ticketCount) {
  return runNodeScriptJson('get-seat-map.mjs', {
    seqNo,
    ticketCount: Number.parseInt(ticketCount, 10) || 2
  });
}

async function fetchSeatCount(seqNo) {
  const cacheKey = String(seqNo);
  const cached = getCacheEntry(seatCountCache, cacheKey);
  if (cached) {
    return cached;
  }

  const result = await fetchSeatMapData(seqNo, 1);
  if (result?.success) {
    setCacheEntry(seatCountCache, cacheKey, result, SEAT_CACHE_TTL_MS);
  }
  return result;
}

function summarizeSeatRegions(regions) {
  let total = 0;
  let sold = 0;

  for (const region of regions || []) {
    for (const row of region.rows || []) {
      for (const seat of row.seats || []) {
        if (seat.seatType === 'E') continue;
        total++;
        if (seat.seatStatus === 3) sold++;
      }
    }
  }

  return { total, sold, available: total - sold };
}

function getCacheEntry(cache, key) {
  const entry = cache.get(key);
  if (!entry) {
    return null;
  }
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function setCacheEntry(cache, key, value, ttlMs) {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function normalizeLlmConfig(input = {}, existing = loadLlmConfig()) {
  const temperature = Number(input.temperature);
  const maxTokens = Number.parseInt(input.maxTokens, 10);

  return {
    provider: 'openai-compatible',
    baseUrl: String(input.baseUrl || existing.baseUrl || DEFAULT_LLM_CONFIG.baseUrl).trim(),
    model: String(input.model || existing.model || DEFAULT_LLM_CONFIG.model).trim(),
    apiKey: String(input.apiKey ?? existing.apiKey ?? '').trim(),
    temperature: Number.isFinite(temperature) ? Math.min(2, Math.max(0, temperature)) : existing.temperature,
    maxTokens: Number.isFinite(maxTokens) ? Math.min(4000, Math.max(200, maxTokens)) : existing.maxTokens,
    systemPrompt: String(input.systemPrompt || existing.systemPrompt || DEFAULT_LLM_CONFIG.systemPrompt).trim()
  };
}

function extractMessageText(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part?.type === 'text') return part.text || '';
        return '';
      })
      .join('')
      .trim();
  }
  return '';
}

async function requestAiScheduleAnalysis(config, payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const prompt = [
    '请基于给定的影院场次数据，分析当前排片是否合理，并输出可执行建议。',
    '必须只基于提供的数据，不要假设外部信息。',
    '请重点关注：',
    '1. 时段覆盖是否均衡',
    '2. 影厅类型与影片/时段是否匹配',
    '3. 上座率与票价是否匹配',
    '4. 是否存在冗余排片、错峰不足、热门时段浪费',
    '5. 给出按影院、电影、时段的具体调排建议',
    '',
    '请按以下 Markdown 结构输出：',
    '## 总体判断',
    '## 主要问题',
    '## 排片建议',
    '## 优先行动清单',
    '',
    '以下是数据：',
    JSON.stringify(payload, null, 2)
  ].join('\n');

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model: config.model,
        temperature: config.temperature,
        max_tokens: config.maxTokens,
        messages: [
          { role: 'system', content: config.systemPrompt },
          { role: 'user', content: prompt }
        ]
      }),
      signal: controller.signal
    });

    const responseText = await response.text();
    let responseJson;
    try {
      responseJson = JSON.parse(responseText);
    } catch {
      throw new Error(`AI 接口返回了无法解析的响应: ${responseText.slice(0, 300)}`);
    }

    if (!response.ok) {
      const errorMessage = responseJson.error?.message || response.statusText || 'AI 接口调用失败';
      throw new Error(errorMessage);
    }

    const content = extractMessageText(responseJson.choices?.[0]?.message?.content);
    if (!content) {
      throw new Error('AI 接口没有返回有效内容');
    }

    return {
      content,
      model: responseJson.model || config.model,
      usage: responseJson.usage || null
    };
  } finally {
    clearTimeout(timeout);
  }
}

app.get('/api/cinemas', (req, res) => {
  try {
    const config = loadConfig();
    res.json({ success: true, data: config });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/auth-url', (req, res) => {
  runNodeScriptJson('get-authkey-link.mjs', undefined, 10000)
    .then((data) => res.json(data))
    .catch((error) => {
      res.status(500).json({ success: false, error: error.message });
    });
});

app.get('/api/llm-config', (req, res) => {
  try {
    const config = loadLlmConfig();
    res.json({
      success: true,
      data: {
        ...config,
        apiKey: '',
        apiKeyFromEnv: Boolean(getLlmApiKeyFromEnv())
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/llm-config', (req, res) => {
  try {
    const config = normalizeLlmConfig(req.body || {});
    if (!config.baseUrl || !config.model) {
      return res.status(400).json({ success: false, error: 'baseUrl 和 model 不能为空' });
    }
    saveLlmConfig(config);
    res.json({ success: true, data: config });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/ai-schedule-analysis', async (req, res) => {
  try {
    const config = loadLlmConfig();
    if (!config.apiKey || !config.baseUrl || !config.model) {
      return res.status(400).json({ success: false, error: '请先完成大模型配置' });
    }

    const { filters = {}, summary = {}, rows = [] } = req.body || {};
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ success: false, error: '缺少可分析的场次数据' });
    }

    const safePayload = {
      filters,
      summary,
      rowCount: rows.length,
      rows: rows.slice(0, 120).map((row) => ({
        cinemaName: row.cinemaName,
        movieName: row.movieName,
        time: row.time,
        endTime: row.endTime,
        hall: row.hall,
        lang: row.lang,
        tp: row.tp,
        price: row.price,
        total: row.total,
        sold: row.sold,
        available: row.available,
        rate: row.rate
      }))
    };

    const result = await requestAiScheduleAnalysis(config, safePayload);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/auth-login', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ success: false, error: 'token required' });

  try {
    const validateResult = await runNodeScriptJson('validate-maoyan-authkey.mjs', { authKey: token }, 15000);
    if (!validateResult.success) {
      return res.status(401).json({ success: false, error: validateResult.error?.message || 'Invalid token' });
    }

    const { userId, userName } = validateResult.data;
    const saveResult = await runNodeScriptJson('save-authkey.mjs', { authKey: token, userId, userName }, 15000);
    res.json(saveResult);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/auth-status', (req, res) => {
  runNodeScriptJson('load-authkey.mjs', undefined, 10000)
    .then((data) => {
      res.json({ success: true, data: { loggedIn: Boolean(data.exists && data.hasToken), userName: data.userName || '' } });
    })
    .catch(() => {
      res.json({ success: true, data: { loggedIn: false } });
    });
});

app.get('/api/shows', async (req, res) => {
  try {
    const config = loadConfig();
    const dateParam = req.query.date;
    const targetDate = dateParam || localDateString();
    const results = [];
    const errors = [];
    const cityNames = new Map(config.cities.map((city) => [city.id, city.name]));

    const BATCH_SIZE = 12;
    for (let i = 0; i < config.cinemas.length; i += BATCH_SIZE) {
      const batch = config.cinemas.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.allSettled(
        batch.map(async (cinema) => {
          try {
            const data = await fetchShowsForCinema(cinema.cinemaId, cinema.cityId);
            const cinemaData = {
              cinemaId: cinema.cinemaId,
              cinemaName: cinema.name,
              cityId: cinema.cityId,
              cityName: cityNames.get(cinema.cityId) || '',
              movies: []
            };

            for (const movie of (data.movies || [])) {
              const movieInfo = {
                movieId: movie.id,
                name: movie.nm,
                score: movie.sc,
                dur: movie.dur,
                shows: []
              };

              for (const dayBlock of (movie.shows || [])) {
                for (const pl of (dayBlock.plist || [])) {
                  if (pl.dt !== targetDate) continue;
                  movieInfo.shows.push({
                    seqNo: pl.seqNo,
                    tm: pl.tm,
                    dt: pl.dt,
                    lang: pl.lang,
                    tp: pl.tp,
                    hall: pl.th || '鏅€氬巺',
                    price: pl.originPrice || ''
                  });
                }
              }

              if (movieInfo.shows.length > 0) {
                cinemaData.movies.push(movieInfo);
              }
            }
            return cinemaData;
          } catch (e) {
            return { cinemaId: cinema.cinemaId, cinemaName: cinema.name, cityId: cinema.cityId, cityName: '', movies: [], error: e.message };
          }
        })
      );

      for (const result of batchResults) {
        if (result.status === 'fulfilled') {
          const cinemaData = result.value;
          if (cinemaData.error) {
            errors.push(`${cinemaData.cinemaName}: ${cinemaData.error}`);
          } else if (cinemaData.movies.length > 0) {
            results.push(cinemaData);
          }
        } else {
          errors.push(result.reason?.message || 'Unknown error');
        }
      }
    }

    if (errors.length > 0) {
      console.warn('Partial failures:', errors.join('; '));
    }

    res.json({ success: true, data: results });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/seat-count', async (req, res) => {
  const { seqNo } = req.query;
  if (!seqNo) {
    return res.status(400).json({ success: false, error: 'seqNo required' });
  }

  try {
    const data = await fetchSeatCount(seqNo);

    if (!data.success) {
      return res.status(401).json({ success: false, error: data.error?.message || 'Failed to get seat count' });
    }

    const summary = summarizeSeatRegions(data.data?.regions);

    res.json({
      success: true,
      data: { seqNo, ...summary }
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/seat-counts', async (req, res) => {
  const { seqNos } = req.body;
  if (!Array.isArray(seqNos)) {
    return res.status(400).json({ success: false, error: 'seqNos array required' });
  }

  try {
    const results = {};
    const uniqueSeqNos = [...new Set(seqNos.filter(Boolean).map((seqNo) => String(seqNo)))];
    const BATCH = 20;
    for (let i = 0; i < uniqueSeqNos.length; i += BATCH) {
      const batch = uniqueSeqNos.slice(i, i + BATCH);
      const batchResults = await Promise.allSettled(
        batch.map(async (seqNo) => {
          const data = await fetchSeatCount(seqNo);
          if (!data.success) return { seqNo, error: data.error?.message };
          return { seqNo, ...summarizeSeatRegions(data.data?.regions) };
        })
      );
      for (const r of batchResults) {
        if (r.status === 'fulfilled' && r.value.seqNo) {
          results[r.value.seqNo] = r.value;
        }
      }
    }
    res.json({ success: true, data: results });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/seat-map', async (req, res) => {
  const { seqNo, ticketCount = 2 } = req.query;
  if (!seqNo) {
    return res.status(400).json({ success: false, error: 'seqNo required' });
  }

  try {
    const data = await fetchSeatMapData(seqNo, ticketCount);

    if (!data.success) {
      return res.status(401).json({ success: false, error: data.error?.message || 'Failed to get seat map' });
    }

    res.json(data);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Cinema show monitor running at http://localhost:${PORT}`);
  console.log(`Open http://localhost:8080 in your browser`);
});
