---
type: changed
---
For scripts that call the daemon's HTTP API: an error's machine-readable code is now always snake_case in the `code` field, with the English sentence in `error` — backend and custom route codes (`duplicate` became `backend_duplicate`, `not-loaded` `backend_not_loaded`, `foreign-shape` `backend_foreign_shape`, `vault-<reason>` `backend_key_not_stored`, `query-refused` `query_refused`), GPT-Live codes (`no-key` became `gpt_live_no_key`…), secrets vault codes (`not-found` became `secret_unknown`…), and the fleet, connector, web terminal, notification sound and secret request routes, which used to put their code in `error`.
