# 影院场次实时监控

实时监控多个影院的排片、票价和座位可售情况，并支持基于当前筛选结果生成 AI 排片建议。

## 功能

- 场次列表：影院、电影、时间、语言、影厅、版本、票价、座位销售情况
- 筛选过滤：按影院、电影、影厅、日期筛选
- 排序：支持按影院、电影、时间、票价、上座率排序
- 座位图：点击场次查看座位图（需登录猫眼账号）
- 分析报告：查看当前筛选结果的汇总分析
- AI 排片建议：基于当前筛选结果分析排片合理性并给出建议
- 本地缓存：查询结果和座位统计会缓存到浏览器 localStorage

## 快速启动

```bash
npm install
npm start
```

然后打开：

```text
http://localhost:8080
```

如果 `8080` 被占用，也可以指定端口：

```bash
PORT=18080 npm start
```

Windows PowerShell:

```powershell
$env:PORT='18080'
npm start
```

## 影院配置

编辑 [config/cinemas.json](config/cinemas.json) 添加你要监控的影院。

示例：

```json
{
  "cities": [
    { "id": 10, "name": "上海" }
  ],
  "cinemas": [
    { "cinemaId": "38989", "name": "金逸影城（上海金融街店）", "cityId": 10 }
  ]
}
```

## AI 模型配置

项目支持 OpenAI 兼容接口。

公开仓库中只保留模板文件 [config/llm.example.json](config/llm.example.json)，真实配置文件 [config/llm.json](config/llm.json) 已被 `.gitignore` 忽略，不应提交到 GitHub。

建议优先使用环境变量提供密钥：

```bash
LLM_API_KEY=your_api_key
```

也可以参考仓库中的 [.env.example](.env.example)。

也兼容：

```bash
OPENAI_API_KEY=your_api_key
```

前端“模型设置”会保存以下非敏感配置到本地 `config/llm.json`：

- `baseUrl`
- `model`
- `temperature`
- `maxTokens`
- `systemPrompt`

如果设置了 `LLM_API_KEY` 或 `OPENAI_API_KEY`，服务端会优先使用环境变量中的密钥。

## 登录猫眼

点击页面右上角“登录猫眼”，输入从手机猫眼 App 获取的 Token。

## 上传 GitHub 前注意事项

- 不要提交 `config/llm.json`
- 不要提交 `node_modules/`
- 不要提交运行日志文件
- 如果你曾经把真实密钥提交过 Git 历史，删除文件还不够，需要清理历史并重新签发密钥

## 技术栈

- 后端：Node.js + Express
- 前端：原生 HTML / CSS / JavaScript
- 数据源：`maoyan-cli`、`maoyan-ticket-booking`
