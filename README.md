# ST-Saver — SillyTavern 手动保存 + 增量同步扩展

基于 [ST-Manual-Saver](https://github.com/GoldenglowMeow/ST-Manual-Saver) 二次开发。
保留原扩展"屏蔽自动保存 + 手动按钮 + 定时放行"的核心，
**新增 line-level 增量同步**：远程使用酒馆时把单次保存流量从 5–46MB 降至 KB 级。

需要配套中转服务：[carryhhkom/st-save-relay](https://github.com/carryhhkom/st-save-relay)

---

## 功能

- 屏蔽 SillyTavern 默认的自动保存请求
- 手动按钮、定时放行（保留原扩展的所有逻辑）
- **拦截 saveChat → 计算 line-level diff → 发给中转 → 中转替你完成全量保存**
- 中转不可达时自动退化为原版全量保存（数据零丢失）
- 不动酒馆代码

## 与原版 ST-Manual-Saver 的关系

- 模块名（`MODULE_NAME`）改成 `st_saver`，UI ID 全部改成 `st_saver_*`
- 设置存储独立（不共用）
- **可以与原版同时安装**（用于对比测试）

## 安装

把这个仓库整个 clone 或下载后，目录改名为 `ST-Saver/`，放到酒馆扩展目录：

```
SillyTavern/public/scripts/extensions/third-party/ST-Saver/
├─ index.js
├─ manifest.json
├─ LICENSE
└─ README.md
```

进酒馆扩展面板，看到 **"ST-Saver (增量同步版)"** 即装好。

## 配置

设置面板 → "ST-Saver — 手动保存 + 增量同步"：

| 选项 | 默认 | 说明 |
|---|---|---|
| 启用插件 | ✓ | 关闭则什么都不做 |
| 启用定时允许自动保存 | ✓ | 每 N 分钟放行一次 |
| 间隔时间（分钟）| 10 | |
| 启用增量同步 | ✓ | 关闭只走"屏蔽 + 全量"模式 |
| 中转地址 | `/relay` | 反代部署用相对路径；直连改为 `http://127.0.0.1:9527` |
| 增量同步调试日志 | ✗ | 控制台打印 `[ST-Saver][Relay]` |

## 部署中转

详见 [st-save-relay](https://github.com/carryhhkom/st-save-relay) 的 QUICKSTART。

简要：
1. 中转跑起来 (`npm start` 或 `docker compose up -d`)
2. 给酒馆配反向代理 `/relay/*` → `:9527`（必须，因为酒馆 session cookie 是 HttpOnly）
3. 扩展面板看到 **"✓ 中转在线"** 即生效

## 致谢

- 原版 [ST-Manual-Saver](https://github.com/GoldenglowMeow/ST-Manual-Saver) by GoldenglowMeow

## License

MIT（沿用原版）
