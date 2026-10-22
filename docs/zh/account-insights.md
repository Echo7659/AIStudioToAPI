# 账号余额、配额与 OAuth JSON 导入

## 查看余额和额度

控制台的「账号管理」内可选择浏览器账号，查看 Google 官方页面返回的预付余额、可用于 Gemini API 的 GCP 赠金、赠金明细和模型配额。来源链接、读取时间和不可读取的原因会一并显示。只有已登录的浏览器账号才能刷新；查询使用临时页面，不会导航正在处理请求的 Build 页面。

这些是官方 Gemini API 的结算账户和配额信息，不等于 AI Studio Build 浏览器会话的免费调用额度：

- 充值余额和赠金分别展示。赠金保留状态、有效期和适用范围，不会把所有 Cloud 试用赠金相加为 Gemini 可用金额。
- Google 的 Rate Limit 页面展示的是过去 28 天内的峰值用量与限额，不能据此计算当前剩余请求次数。
- `1 / 40` 仅表示本地账号轮换进度，不参与余额或官方配额计算。
- 无权限、需要重新登录、未暴露金额或页面变更时显示未知，不会将读取失败视为余额为零。

查询会缓存结果；手动刷新会重新读取 Google 页面，不会发起模型推理或改变账单设置。Google 官方页面结构可能变更，届时应通过来源链接核对。

## 导入 OAuth JSON

点击「导入 OAuth JSON」，粘贴 JSON 或选择一个、多个 `.json` 文件。支持单条记录、数组、`accounts` 包装和 Google `authorized_user` 格式，也兼容 Antigravity 导出中的 `email`、`refresh_token` 及嵌套 `token.refresh_token`。

```json
{
  "accounts": [
    {
      "email": "your-account@example.com",
      "refresh_token": "YOUR_REFRESH_TOKEN",
      "client_id": "ORIGINAL_GOOGLE_OAUTH_CLIENT_ID",
      "client_secret": "ORIGINAL_CLIENT_SECRET_IF_REQUIRED"
    }
  ]
}
```

凭据未包含 `client_id` 时，可以在服务端 `.env` 或 Compose 的 `environment` 中设置原始授权客户端。刷新令牌不能使用其他应用的客户端 ID；公开客户端可以不需要 secret。

```dotenv
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
```

导入成功表示记录已保存。「验证身份」会通过固定的 Google OAuth 和用户信息端点核对邮箱，不生成内容或扩展授权权限。缺少 OAuth 客户端、刷新失败和身份不匹配会分别提示。同邮箱重复导入会更新原记录，替换凭据后需要重新验证。

**OAuth access token 不等于 Google 网页登录 Cookie。** 在 Build 通道中，仍需为同一邮箱完成一次「网页登录」才能使用浏览器会话，OAuth 记录不会直接加入 Build 轮换池。原来的浏览器 Auth JSON/ZIP 上传入口继续保留。

## OAuth 账号直接调用官方 Gemini API

导入账号后，在同一面板将「API 通道」切换为「官方 Gemini API」，选择 OAuth 账号并填写 Cloud 项目 ID，保存后继续使用原来的客户端 API Key 和 `/v1`、`/v1beta` 地址即可。首次调用会自动刷新 OAuth 凭据并验证身份，无需网页登录；OpenAI Chat Completions、Responses、Claude Messages 和原生 Gemini 格式复用现有转换与流式响应逻辑。

该通道使用所选 Cloud 项目的官方 Gemini API 额度和计费，项目必须启用对应 API，且 OAuth 授权必须具有所需权限。赠金是否适用、付费账户能否调用取决于 Google 的计费状态。**切换通道不会自动充值、开启付费、扩展 OAuth 授权或发起模型调用。**

默认通道仍为 Build。官方通道失败会返回错误，不会偷偷改用 Build 或其他账号，也不会自动重试付费生成请求。官方模型列表从 Google 获取；当前官方通道不支持 Files API/文件上传。

在无界面环境可覆盖通道设置：

```dotenv
API_UPSTREAM_CHANNEL=oauth
GOOGLE_OAUTH_ACCOUNT_ID=IMPORTED_ACCOUNT_ID
GOOGLE_OAUTH_PROJECT_ID=YOUR_CLOUD_PROJECT_ID
```

设置 `API_UPSTREAM_CHANNEL` 后，控制台将显示由环境变量管理；留空时使用持久化的 `data/upstream-channel.json`。删除当前官方通道使用的 OAuth 账号前，需先切换通道或账号。

仅导入 OAuth、尚无同邮箱网页会话的账号可以直接调用官方 API，但暂时无法读取 Google 账单网页中的余额。面板会显示这一原因；关联同邮箱浏览器登录后可查询金额。余额读取和模型调用是两个独立能力。

OAuth 凭据保存在 `configs/auth/oauth-accounts.json`，独立于 `auth-N.json`；已有 Docker `/app/configs/auth` 挂载会一并持久化。文件按平台支持设置为仅当前用户可读写，列表接口不返回 Token 或 secret，界面也不会写入浏览器本地存储。

## 无界面调用

以下管理接口使用控制台登录会话；推理 API Key 无法访问。响应使用 `Cache-Control: no-store`。

- `GET /api/oauth/accounts`：列出不含凭据的账号摘要。
- `POST /api/oauth/accounts/import`：`{"content": <JSON 对象、数组或 JSON 字符串>}`，返回逐项结果，支持部分成功。
- `POST /api/oauth/accounts/:id/verify`：验证身份。
- `DELETE /api/oauth/accounts/:id`：删除指定 OAuth 记录，不删除浏览器账号。
- `GET /api/accounts/:index/insights`：读取余额、赠金及配额快照。
- `POST /api/accounts/:index/insights/refresh`：刷新指定浏览器账号的快照。
- `GET /api/oauth/accounts/:id/insights`、`POST /api/oauth/accounts/:id/insights/refresh`：查询已验证 OAuth 账号关联的浏览器账单信息。
- `GET /api/settings/upstream-channel`、`PUT /api/settings/upstream-channel`：读取、保存 `mode`、`accountId` 和 `projectId`。

每次 OAuth 导入最多 5 MiB、1000 个账号。不要把包含真实 Token 的 JSON 放进 Git、日志或公开工单。
