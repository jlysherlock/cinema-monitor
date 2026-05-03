const express = require('express');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const PORT = 8080;
const BASE_DIR = path.join(__dirname);
const CONFIG_PATH = path.join(BASE_DIR, 'config', 'cinemas.json');

app.use(express.json());
app.use(express.static(path.join(BASE_DIR, 'public')));

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
}

function execPromise(cmd, encoding = 'utf-8') {
  return new Promise((resolve, reject) => {
    exec(cmd, { encoding, timeout: 30000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message || 'Command failed'));
      else resolve(stdout);
    });
  });
}

async function execPromiseStdout(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { encoding: 'utf-8', timeout: 30000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message || 'Command failed'));
      else if (!stdout || stdout.trim() === '') reject(new Error('No output'));
      else resolve(stdout);
    });
  });
}

async function fetchShowsForCinema(cinemaId, cityId) {
  const cmd = `py -3 ${path.join(BASE_DIR, 'skills/maoyan-cli/scripts/maoyan_cli.py')} shows ${cinemaId} ${cityId}`;
  const output = await execPromise(cmd);
  return JSON.parse(output);
}

async function fetchSeatMapData(seqNo, ticketCount) {
  const input = { seqNo, ticketCount: parseInt(ticketCount) || 2 };
  const tmpFile = path.join(os.tmpdir(), 'seat_input_' + Date.now() + '.json');
  fs.writeFileSync(tmpFile, JSON.stringify(input));
  try {
    const cmd = `node "${path.join(BASE_DIR, 'skills/maoyan-ticket-booking/scripts/get-seat-map.mjs')}" < "${tmpFile}"`;
    return JSON.parse(await execPromiseStdout(cmd));
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

async function fetchSeatCount(seqNo) {
  return fetchSeatMapData(seqNo, 1);
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
  const cmd = `node "${path.join(BASE_DIR, 'skills/maoyan-ticket-booking/scripts/get-authkey-link.mjs')}"`;
  exec(cmd, { encoding: 'utf-8', timeout: 10000 }, (err, stdout, stderr) => {
    if (err) return res.status(500).json({ success: false, error: err.message });
    const data = JSON.parse(stdout);
    res.json(data);
  });
});

app.post('/api/auth-login', (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ success: false, error: 'token required' });

  const validateCmd = `node "${path.join(BASE_DIR, 'skills/maoyan-ticket-booking/scripts/validate-maoyan-authkey.mjs')}"`;
  const validateInput = JSON.stringify({ authKey: token });

  const tmpFile = path.join(os.tmpdir(), 'auth_validate_' + Date.now() + '.json');
  fs.writeFileSync(tmpFile, validateInput);

  exec(`${validateCmd} < "${tmpFile}"`, { encoding: 'utf-8', timeout: 15000 }, (err, stdout, stderr) => {
    try { fs.unlinkSync(tmpFile); } catch {}
    if (err) return res.status(500).json({ success: false, error: err.message });

    const validateResult = JSON.parse(stdout);
    if (!validateResult.success) {
      return res.status(401).json({ success: false, error: validateResult.error?.message || 'Invalid token' });
    }

    const { userId, userName } = validateResult.data;
    const saveInput = JSON.stringify({ authKey: token, userId, userName });
    const saveTmpFile = path.join(os.tmpdir(), 'auth_save_' + Date.now() + '.json');
    fs.writeFileSync(saveTmpFile, saveInput);

    const saveCmd = `node "${path.join(BASE_DIR, 'skills/maoyan-ticket-booking/scripts/save-authkey.mjs')}"`;
    exec(`${saveCmd} < "${saveTmpFile}"`, { encoding: 'utf-8', timeout: 15000 }, (err2, stdout2, stderr2) => {
      try { fs.unlinkSync(saveTmpFile); } catch {}
      if (err2) return res.status(500).json({ success: false, error: err2.message });
      const saveResult = JSON.parse(stdout2);
      res.json(saveResult);
    });
  });
});

app.get('/api/auth-status', (req, res) => {
  const cmd = `node "${path.join(BASE_DIR, 'skills/maoyan-ticket-booking/scripts/load-authkey.mjs')}"`;
  exec(cmd, { encoding: 'utf-8', timeout: 10000 }, (err, stdout, stderr) => {
    if (err) return res.json({ success: true, data: { loggedIn: false } });
    const data = JSON.parse(stdout);
    res.json({ success: true, data: { loggedIn: data.exists && data.hasToken, userName: data.userName || '' } });
  });
});

app.get('/api/shows', async (req, res) => {
  try {
    const config = loadConfig();
    const dateParam = req.query.date;
    const targetDate = dateParam || new Date().toISOString().split('T')[0];
    const results = [];
    const errors = [];

    const BATCH_SIZE = 8;
    for (let i = 0; i < config.cinemas.length; i += BATCH_SIZE) {
      const batch = config.cinemas.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.allSettled(
        batch.map(async (cinema) => {
          try {
            const data = await fetchShowsForCinema(cinema.cinemaId, cinema.cityId);
            const city = config.cities.find(c => c.id === cinema.cityId);
            const cinemaData = {
              cinemaId: cinema.cinemaId,
              cinemaName: cinema.name,
              cityId: cinema.cityId,
              cityName: city ? city.name : '',
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
                    hall: pl.th || '普通厅',
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

    const regions = data.data?.regions || [];
    let totalSeats = 0;
    let soldSeats = 0;

    for (const region of regions) {
      for (const row of region.rows || []) {
        for (const seat of row.seats || []) {
          if (seat.seatType === 'E') continue;
          totalSeats++;
          if (seat.seatStatus === 3) soldSeats++;
        }
      }
    }

    res.json({
      success: true,
      data: { seqNo, total: totalSeats, sold: soldSeats, available: totalSeats - soldSeats }
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
    const BATCH = 10;
    for (let i = 0; i < seqNos.length; i += BATCH) {
      const batch = seqNos.slice(i, i + BATCH);
      const batchResults = await Promise.allSettled(
        batch.map(async (seqNo) => {
          const data = await fetchSeatCount(seqNo);
          if (!data.success) return { seqNo, error: data.error?.message };
          const regions = data.data?.regions || [];
          let total = 0, sold = 0;
          for (const region of regions) {
            for (const row of region.rows || []) {
              for (const seat of row.seats || []) {
                if (seat.seatType === 'E') continue;
                total++;
                if (seat.seatStatus === 3) sold++;
              }
            }
          }
          return { seqNo, total, sold, available: total - sold };
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