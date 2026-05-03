# 影院场次实时监控

实时监控多个影院的排片、票价和座位可售情况。

## 功能

- 场次列表：电影名、评分、时长、时间、语言、影厅、版本、票价
- 座位状态：总座位、已售、上座率（进度条展示）
- 筛选过滤：按城市、影院、电影、日期筛选
- 排序：支持任意列升序/降序排列
- 座位图：点击场次查看座位图（需登录猫眼账号）
- 数据缓存：查询结果缓存到 localStorage

## 快速启动

```bash
npm install
npm start
```

然后浏览器打开 http://localhost:8080

## 配置

编辑 `config/cinemas.json` 添加关注的影院：

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

## 登录猫眼账号

点击页面右上角「登录猫眼」按钮，输入 Token（从手机猫眼 App 获取）。

## 技术栈

- 后端：Node.js + Express
- 前端：纯 HTML/CSS/JS 单文件
- 数据源：maoyan-cli（排片价格）、maoyan-ticket-booking（座位图）
