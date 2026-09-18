# 2026-09-12 Desktop 更新后的执行恢复

## 实际故障

原 owner 配置指向 Desktop 的 `7ac07f4ce733f89a/codex.exe`，更新后该文件已不存在；当前唯一枚举到的已安装 Desktop 可执行文件位于 `bffc5354119c8421/codex.exe`，版本为 `0.154.0-alpha.6.2`。仅检查系统 PATH 不能修复已指定但失效的绝对路径。

使用已有 `repair-installed-codex.ts` 和正常配置更新接口，保留原配置备份，只修改 Codex command。补充修复脚本的 prerelease SemVer 校验，不把合法预发布版本误判成不存在。实际可执行文件 SHA-256 为 `081e4de4be8e38fac6ed4d95e3b1a0b9f6d31c090ddc36e1696b349fe406f575`。未更改账号、密钥、Codex Home 或历史数据。

之后项目登记适配器仍只接受 0.153.4。已从当前安装二进制生成 experimental JSON schema，并核对 Project/List/Create/Read、Thread/Read、Thread/MetadataUpdate 所需字段。将这一个实际核对过的预发布版本加入明确允许列表；不通配接受未知后续版本，运行时 schema、provider-home、项目与线程归属检查继续保留。

## 已验证结果

- 十项版本/目录/项目定向测试全部通过。
- 正常源码 CLI 的真实项目登记命令终态 exit0；终端正文回传一次被拦截，未将未知 GUI 状态冒充已验收。
- 完整源码回归：318 tests，311 pass，0 fail，7 个平台 skip；TypeScript 类型检查通过。
- 完整测试收据：`releases/test-receipts/2026-09-12T01-19-48-930Z-9f52e371-c493-4d99-8f87-87ea746ea963.json`；运行期间源码指纹 `0f020708bb08bd7320ea295bfd26276bc14cc09916b23ee339810fc856862a77` 未变化。
- 原生 current-config client 在确认无活动 turn 后启用当前 agentd。旧线程的 thread/resume 又被 provider 明确拒绝；保留原线程，并在同一已授权工作区与工作账本中显式交接当前剩余任务。
- 新执行 `agt_23f73f06` / thread `01a09331-8635-7a73-a001-f4bff4c5a5ec` 实际产生 provider turn `01a09331-8f99-74f0-a23c-d4554a5c21ca` 和命令活动。它不是只排队成功，也不是删除原线程后新建替代历史。

## 边界

没有重启本轮在用的 MCP 主服务、修改其身份验证、清锁、清数据库或终止无关线程。MCP 启动时缓存的 provider 配置与当前文件版本可能不同；本次显式维护脚本调用同一认证 daemon、scope、queue、ledger，只使用当前有效配置，不绕过项目或写入授权。

`scripts/cos-closure-control-20260912.ts` 是本次指定任务的有界运维辅助，不是面向所有项目的通用 CLI。它不应作为自动更新程序路径的长期替代。未知后续版本仍必须核对协议，不能通过关闭项目登记检查恢复执行。

本记录只说明开发执行恢复，不代表 COS 已切生产。所有业务迁移仍需各自真实验证与主控切换 checkpoint。
