# ST-Saver — SillyTavern 手动保存 + 增量同步扩展

基于 [ST-Manual-Saver](https://github.com/GoldenglowMeow/ST-Manual-Saver) 二次开发。
**新增 line-level 增量同步**：远程使用酒馆时把单次保存流量从 5–46 MB 降至 KB 级。

需要配套中转服务：[carryhhkom/st-save-relay](https://github.com/carryhhkom/st-save-relay)

---

## 工作模式

打开扩展面板 → "ST-Saver — 手动保存 + 增量同步"，里面有两组核心开关。
两组互斥（"启用增量同步"开了之后会自动接管），按需选一种：

### 模式 A：增量同步（推荐）

**前提**：你已经部署了 [st-save-relay](https://github.com/carryhhkom/st-save-relay) 中转服务。

行为：
- **每次酒馆触发 saveChat 都即时走增量**（生成回复、改消息、swipe、表格插件改动等）
- 单次保存只上传变化的几行（KB 级），不再上传整个 jsonl
- 中转挂掉/失败 → 自动回退到原版全量保存（数据零丢失）
- 不再需要"屏蔽 + 定时放行"机制（设置面板的"定时保存"区域会自动灰掉）
- 自动保存 toast 静默；手动按钮 / 失败时弹 toast

### 模式 B：手动 + 定时放行（沿用原版）

不部署中转 / 关闭"启用增量同步"时启用。

行为：
- 屏蔽酒馆所有自动保存请求
- 提供"保存聊天 (ST-Saver)"按钮手动触发
- 可选：每 N 分钟放行一次自动保存
- 放行的保存仍是全量（跟原版一样）

---

## 与原版 ST-Manual-Saver 的关系

- 模块名 `MODULE_NAME` 改成 `st_saver`，UI ID 全部改成 `st_saver_*`
- 设置存储独立（不共用），按钮 ID 不同
- **可以与原版同时安装**（用于对比测试）—— 但同时启用两个会冲突，**测试时只启用其中一个**

---

## 安装

```bash
cd SillyTavern/public/scripts/extensions/third-party/
git clone https://github.com/carryhhkom/ST-Saver.git
```

进酒馆 → 扩展面板 → 看到 **"ST-Saver (增量同步版)"** 即装好。

## 配置项

| 选项 | 默认 | 说明 |
|---|---|---|
| 启用插件 | ✓ | 关闭则什么都不做 |
| 启用增量同步 | ✓ | 开启 = 模式 A；关闭 = 模式 B |
| 中转地址 | `http://127.0.0.1:9527` | 远程访问填中转服务器 IP/域名:9527 |
| 增量同步调试日志 | ✗ | 开启后控制台打印 `[ST-Saver][Relay]` |
| 启用定时允许自动保存 | ✓ | 仅模式 B 生效。每 N 分钟放行一次 |
| 间隔时间（分钟）| 10 | 仅模式 B 生效 |

## 部署中转

详见 [st-save-relay 的 QUICKSTART](https://github.com/carryhhkom/st-save-relay/blob/main/QUICKSTART.md)。

简要：
1. 中转跑起来 (`npm start` / `docker compose up -d`)，与酒馆**同机部署**
2. 酒馆需要是单用户模式（`enableUserAccounts: false`）
3. 扩展面板填中转地址 `http://你的服务器IP:9527`，看到 **"✓ 中转在线"** 即生效

中转**不需要反向代理**——它启动时自己调酒馆 `/csrf-token` 拿到 cookie 和 token，扩展端只发裸 HTTP 请求，简单干净。

## 数据安全

不变式：**酒馆磁盘上的 jsonl 是唯一真理。**

- 增量失败 → 全量兜底
- 中转挂 → 跟没装这个扩展时一模一样
- 多端冲突 → 中转校验 fingerprint 后让扩展端重建基线
- 任何错误路径都不丢数据

## 致谢

- 原版 [ST-Manual-Saver](https://github.com/GoldenglowMeow/ST-Manual-Saver) by GoldenglowMeow

## License

MIT（沿用原版）
