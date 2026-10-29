# Harness 独立会话接入（v3）

普通微信聊天使用官方 @deepseek-ai/dsh-sdk-client@0.2.1-rc.4 与匹配运行时。联系人和群聊按平台、会话类型、真实 chatId 分别映射为持久 Session ID，同一会话排队处理。重启后用 resumeSession 恢复，失败不会另起空会话。命令、外部动作和回应规则仍由项目负责。

完整人设仍在原人设页面修改；启动时导出到 data/harness-chat/skills/whale-persona/SKILL.md。每轮由程序将完整人设和适用要求固定加入上下文，不依赖模型自行调用原生 skill 工具。生成的 Skill 文件是导出副本。尚未安装额外的长期记忆插件；本次使用原生持久会话、上下文整理及项目已有共通记忆。

首次接入仅带入本次已选中的本会话最近 20 条历史资料，不重放旧操作；之后由 Harness 延续会话。原始存档保留。没有批量导入全部微信历史。

映射位于 data/harness-chat/sessions.json，原生数据位于其 home 下，均不纳入 Git。自主任务页显示后端和已建立会话数。SDK 没有图形客户端，本次不会在官方桌面应用里自动打开窗口。

config.json 中 harness.enabled 支持配置热加载。改为 false 即恢复原 API，Harness 存档保留。模型和 API Key 读取现有设置，识图不变。专用 patch 禁用了会话日志上传、文件工具和 shell 工具。

依赖安装到 runtime/harness，不全局安装：

```powershell
npm.cmd install --prefix runtime/harness --save-exact @deepseek-ai/dsh-sdk-client@0.2.1-rc.4 --no-audit --no-fund --cache data/npm-cache
```

本机 Node 22.19.0 已验证可用，旧 Node 22.14.0 无法完成握手。旧可执行文件和配置已备份到 data/before-harness-activation-*。已验证真实 SDK 的合成会话跨进程恢复，不代表所有实际聊天的语言质量已验证。

中断中的会话会标记 uncertain，不向另一后端重复生成，需要检查记录后恢复，目前没有图形恢复入口。
