# WordSteps 阶梯背单词 — 项目记忆

## 项目概述
- 离线优先的 PWA 阶梯背单词应用
- 仓库：https://github.com/ChenJJ-DZL/wordsteps.git
- 本地路径：C:/Users/chenj/WorkBuddy/阶梯单词/
- 技术栈：原生 JS (IIFE) + CSS，无框架，localStorage 持久化，Service Worker 离线

## 架构要点
- 四视图：首页(概览) / 学习(新词) / 复习 / 历史
- 数据流：词库 JS 懒加载 → app.js 状态管理 → localStorage 读写
- SRS 引擎：9级艾宾浩斯间隔，三档评分(认识/模糊/不认识)
- 增量模式：高阶词库自动过滤低阶已学词

## 代码结构
- `index.html` - 入口 + 视图模板
- `app.js` - 全部业务逻辑 (783行，需重构)
- `styles.css` - 样式 (CSS 变量体系)
- `sw.js` - Service Worker (v17)
- `books/manifest.js` - 词库注册表
- `books/*.js` - 9本词书数据
- `books/en_defs.js` - 离线英文释义 (~28K条目)

## 关键约定
- 版本号：APP_VER 控制缓存刷新，SCHEMA_VER 控制数据迁移
- 排序方式：默认"词根"（round-robin 交错聚类），可选字母/词频
- 发音：离线音频 URL 优先，Web Speech API TTS 兜底
- 增量模式：基础词(ogden)和初中(chuzhong)始终显示全量

## 下一步计划
参考报告：`.workbuddy/reports/wordsteps-analysis-report.html`
