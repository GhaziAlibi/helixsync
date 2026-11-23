# Troubleshooting

| Symptom | Cause and fix |
|---------|---------------|
| `server` exits at startup mentioning `JWT_SIGNING_KEY` | The key is missing, shorter than 32 characters, or still contains `change-me` / `replace-me`. Generate one with `openssl rand -base64 48`. |
| `server` exits at startup mentioning `DATABASE_URL` and a placeholder | `POSTGRES_PASSWORD` still has the `.env.example` value. Set it with `openssl rand -hex 32`. PostgreSQL keeps the password it was first started with, so if the stack already ran once, also run `docker compose exec postgres psql -U helixsync -c "ALTER ROLE helixsync PASSWORD '<the new value>'"`. |
| `server` exits at startup naming another variable | Its value doesn't parse or is out of range; the message says what is expected. See [`deployment.md`](deployment.md#configuration-reference). |
| `docker compose` says `HELIXSYNC_VERSION is missing a value` | `docker-compose.prod.yml` needs a released version in `.env`, for example `HELIXSYNC_VERSION=1.0.0`. |
| The extension says the Server URL must use `https://` | Only `localhost`, `127.0.0.1` and `[::1]` may use plain HTTP. Put a TLS proxy in front of `web` ([option D](installation.md#d-reverse-proxy-with-https)). |
| The dashboard signs you out immediately, or warns that the page is not using HTTPS | Session cookies are `Secure`; load the dashboard over HTTPS (or from `localhost`). |
| Registering returns `registration_disabled` | The server has `ALLOW_REGISTRATION=false`. Set it to `true` temporarily to add an account. |
| A user forgot their password | They reset it with their recovery code (**Forgot your password?** on the sign-in page). Without the code, run `docker compose exec server /app/helixsync-server delete-account <email>` once you've checked who's asking, and they register again. |
| The extension shows an "update the HelixSync extension" error | It met sync data written in a newer format. Update the extension; nothing is lost, and it retries automatically. |
| Everyone gets `429` rate-limit errors after one client misbehaves | The rate limiter sees all clients as the proxy's address. Make sure your proxy sets `X-Forwarded-For`, and see [`deployment.md`](deployment.md#real-client-ips-behind-that-reverse-proxy). |

For anything else, check `docker compose logs server` and the extension's
service-worker console, then open an
[issue](https://github.com/GhaziAlibi/helixsync/issues) (without secrets or
synced data in it).
