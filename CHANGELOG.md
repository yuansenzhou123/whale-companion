# 更新记录

## 3.0.0

这一次主要修「主人识别」（`persona.master`）—— 之前就算在调试台把名单填对，微信里她仍然不认。

### 主人识别

- **统一判定**：新增 `src/master.js`，`matchMaster()` / `masterWarnings()` 是全项目唯一的主人与非主人判定。
  - 微信里只认不可修改的 `senderId`（`wxid_xxx`）；
  - 网页 / 抖音这类没有稳定 id 的渠道才允许按昵称认；
  - `wxids` 里有真 `wxid_` 值时昵称不能用来提权（防止改昵称冒充）。
- **修掉「填微信号静默失效」**：`master.wxids` 写成自己设的微信号（`abc12345` 这种）时，旧逻辑会连昵称兜底一起关掉，导致谁都不算主人。现在会识别出「这不像 wxid」并告警，同时在没有任何真 wxid 时退回昵称认。
- **调试台和真实链路一致**：`server.js` 的提示词预览改用同一个 `matchMaster()`，不会再出现「调试台说认了、微信里没认」。
- **认了之后要认账**：新增提示词段 `IDENTITY_FIX`（`src/persona.js`），让「名单还没配好时她说的否认」作废；`bot.js` 的 `stripMasterDispute()` 在**主人本人**说话时，把历史里「我是你主人吗 / 我是谁 / 你的主人是谁」这类追问连同她的否认整段剔掉（只影响本轮喂给模型的内容，记忆文件不动）；`finalize()` 再兜一层：模型若仍说出「别自封了 / 就一个名字罢了 / 冒充没用」，直接改成认下来。
- **可观测**：每条微信私聊在 `data/whale.log` 写一行 `[master] 私聊 昵称（wxid）→ 主人/非主人（原因）`；昵称在名单里但 id 对不上时额外 WARN 一次，直接告诉你该把哪串填进 `master.wxids`。
- 调试台「身份 / 主人」卡片新增：主人名单告警、「最近说过话的人（真实 senderId）」，以及提示词预览里的「按 wxid 认的 / 按昵称认的 / 昵称对得上但被挡住」。

### 测试与工具链

- `npm test` 改为 `node --test "tests/*.test.js"`：原来会扫进 `runtime/python/Lib/site-packages` 里 Python 包自带的 3 个 `.js`，一直报假失败。
- 修 `tests/providers.test.js` 把 `loadConfig({ root, env })` 写成 `loadConfig(root, {})`：`root` 落到真实项目目录，**跑一次测试就会把用户的 `data/settings.json` 覆盖成测试用的假 Key**。现在只用临时目录。
- 修 `saveSettings()` 用自算的 `keys` 覆盖调用方显式传入的 `keys`，导致「别的服务商的 Key 存不住、主 Key 失效时切不到备用」。
- `tests/voice.test.js` 不再要求 `data/persona.json` 一定存在（运行时才生成的文件）。
- `一键修复并自检.bat` 由 LF 改为 CRLF（cmd 才不报语法错）。
- 新增测试：`tests/master-match.test.js`（13 条）+ `tests/master.test.js` 里 6 条（身份纠错、剔除争执段、无关历史保留、普通人不受影响、否认兜底）。

### 仓库整理

- `.gitignore` 增加 `wechatauto_db/`（微信数据库快照，含隐私）；不再忽略 `tools/`（`hotkey_daemon.py` 是项目自己的热键脚本，被 `启动热键.bat` 调用）。
- 版本号 `3.0.0`。

## 2.9.2

上一个分发包的基线版本，无单独记录。
