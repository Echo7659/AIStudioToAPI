# Account balances, quotas and OAuth JSON import

## Billing and quota insights

Select a signed-in browser account in Account Management to read its official Google billing and quota pages. Results include prepaid balance when exposed, eligible GCP credits, individual promotional credits, source links and collection time. Temporary pages are closed after collection; the active Build page is never navigated.

These are **official Gemini API billing and quota figures**, which do not describe the free allowance of an AI Studio Build browser session:

- Prepaid funds and promotional credits remain separate. Credit status, expiry and service scope are retained; Cloud trial credits are never added together as a Gemini balance.
- Google's Rate Limit page reports peak usage over the last 28 days. That is not current usage and cannot establish remaining requests.
- The local `1 / 40` rotation counter is unrelated to money or Google quota.
- Missing permission, expired login, unsupported fields and page changes produce an explicit unknown state rather than a zero balance.

Results are cached. Manual refresh reads the official pages again without inference or billing changes. If Google's page structure changes, consult the linked official source.

## OAuth JSON import

Use Import OAuth JSON to paste JSON or select one or more `.json` files. Supported inputs include a single record, an array, an `accounts` wrapper, Google `authorized_user`, and Antigravity exports using `email`, `refresh_token` or `token.refresh_token`.

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

If the JSON omits the original client, configure `GOOGLE_OAUTH_CLIENT_ID` and optionally `GOOGLE_OAUTH_CLIENT_SECRET` in server `.env` or Compose `environment`. A refresh token cannot be used with an unrelated client's ID. Public clients may not require a secret.

Import success means the record was saved. Verify Identity refreshes through fixed Google endpoints and checks the verified email without inference or scope escalation. Missing clients, refresh failures and identity mismatches have distinct errors. Reimporting the same email updates its record; changed credentials require verification again.

**OAuth access tokens are not Google website login cookies.** Build mode still requires a browser login for the same email. OAuth-only records never enter the Build rotation pool. Existing browser Auth JSON/ZIP uploads remain available.

## Calling the official Gemini API with OAuth

After importing an account, select Official Gemini API in the contextual API Channel settings, choose the OAuth account and enter its Cloud project ID. Save and keep using the existing client API key and `/v1` or `/v1beta` URLs. First use refreshes the credential and verifies identity automatically, without a browser login. OpenAI Chat Completions, Responses, Claude Messages and native Gemini reuse the existing converters and streaming handlers.

This channel uses the selected Cloud project's **official Gemini API quota and billing**. The project must enable the API and the OAuth grant must have the required permissions. Google determines credit eligibility and billing availability. Switching channels never tops up funds, enables billing, expands OAuth scopes or sends inference.

Build remains the default. Official API errors never silently fall back to Build or another account, and paid generation is not automatically retried. The official model catalog comes from Google. Files API and file uploads are currently unsupported by the official channel.

Headless configuration can override console settings:

```dotenv
API_UPSTREAM_CHANNEL=oauth
GOOGLE_OAUTH_ACCOUNT_ID=IMPORTED_ACCOUNT_ID
GOOGLE_OAUTH_PROJECT_ID=YOUR_CLOUD_PROJECT_ID
```

When `API_UPSTREAM_CHANNEL` is set, the UI is read-only. Otherwise settings persist in `data/upstream-channel.json`. Switch channels or accounts before deleting the active OAuth credential.

OAuth-only accounts can call the official API without a browser, but financial page collection still requires a matching signed-in browser account. The insights panel reports that limitation explicitly. Inference authorization and billing-page access are independent capabilities.

Credentials are stored separately in `configs/auth/oauth-accounts.json`, covered by the existing Docker `/app/configs/auth` mount. Private file permissions are applied where supported. List responses omit tokens and secrets; credentials are not written to browser local storage.

## Headless management

These endpoints require an authenticated console session, not an inference API key, and use `Cache-Control: no-store`:

- `GET /api/oauth/accounts`: public account summaries.
- `POST /api/oauth/accounts/import`: `{"content": <JSON object, array or string>}`, with per-item results and partial success.
- `POST /api/oauth/accounts/:id/verify`: verify identity.
- `DELETE /api/oauth/accounts/:id`: delete only the OAuth record.
- `GET /api/accounts/:index/insights`: cached billing/quota snapshot.
- `POST /api/accounts/:index/insights/refresh`: refresh one browser account.
- `GET /api/oauth/accounts/:id/insights`, `POST /api/oauth/accounts/:id/insights/refresh`: query the verified OAuth identity's matching browser account.
- `GET /api/settings/upstream-channel`, `PUT /api/settings/upstream-channel`: read or save `mode`, `accountId` and `projectId`.

OAuth imports are limited to 5 MiB and 1,000 records per request. Keep real credentials out of Git, logs and public issues.
