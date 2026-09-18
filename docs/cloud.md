# Loom Cloud setup (Supabase)

One Supabase project powers three optional features:

| Feature | Uses | Without it |
|---|---|---|
| **Loom Cloud relay**: phone ↔ computer from any network | Realtime (broadcast) | The phone works on the same Wi-Fi or tailnet only |
| **Sign in with Google** in the phone app | Auth | "Continue without an account" still works fully |
| **Anonymous usage stats** (country only) | one Postgres table | Nothing is sent |

The free tier covers all three. Loom runs no server of its own.

## 1. Create the project

1. Go to https://supabase.com/dashboard and create a **New project**.
2. Open **Project Settings → API** and copy two values:
   - the **Project URL**: `https://<ref>.supabase.co`
   - the **anon public** key.

   The anon key is designed to be public. It ships inside the app, and everything
   it can reach is locked down by the policies below.

## 2. Realtime (the relay)

The relay uses **broadcast** channels named `loom-relay:<random id>`. Nothing is
stored, and every message is end-to-end encrypted with a key that exists only in
your pairing QR.

- **Realtime → Settings**: keep **public channels allowed**. This is the default.
  If "private channels only" is on, the relay can't join.

Turn it on for your computer:

```bash
loom cloud enable --url https://<ref>.supabase.co --key <anon key>
loom pair       # the QR now carries the relay credentials in its #fragment
```

Or set `LOOM_SUPABASE_URL` / `LOOM_SUPABASE_ANON_KEY` in the daemon's environment
and use **Settings → Loom Cloud** in the desktop app.

- `loom cloud rotate` mints a new key. Phones that paired through the cloud must
  pair again.
- `loom cloud disable` leaves the channel.

## 3. Sign in with Google

1. **Google Cloud Console → APIs & Services → Credentials → Create credentials →
   OAuth client ID**:
   - Application type: **Web application**
   - Authorized redirect URI: `https://<ref>.supabase.co/auth/v1/callback`
2. **Supabase → Authentication → Sign In / Providers → Google**:
   - enable it;
   - paste the **Client ID** and **Client secret**.
3. **Supabase → Authentication → URL Configuration → Redirect URLs**: add
   - `loom://auth-callback` (installed app)
   - `exp://**`, for development in Expo Go only.
4. In the phone app, copy `app/.env.example` to `app/.env` and fill in:

   ```
   EXPO_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co
   EXPO_PUBLIC_SUPABASE_ANON_KEY=<anon key>
   ```

   For EAS builds, set the same two names as EAS environment variables.

An account is optional. Loom's local features never need one.

## 4. Anonymous usage stats

Run [`supabase/migrations/0001_app_opens.sql`](../supabase/migrations/0001_app_opens.sql)
in **SQL Editor**, or use `supabase db push` if you use the CLI.

**What is collected, per app open (at most once a day):**
- **country**: from the phone's region setting. No IP address, no location.
- **platform**
- **app version**

**What is not collected:** no user id, no device id, no email, no prompts, no code.

- Anyone can insert. Nobody but the service role can read.
- The phone app has an **Anonymous usage stats** switch to turn it off.

Read the counts in the SQL editor, which runs as the service role:

```sql
select country, count(*) from app_opens group by 1 order by 2 desc;
```

## Security model, in one paragraph

- **Supabase relays but cannot read.** Every relay message is
  XChaCha20-Poly1305-sealed with a 32-byte key minted on your computer. That key
  travels only in the pairing link's URL fragment, which is never sent to a server.
- **Requests are authorized exactly as on the LAN.** Your computer runs each
  relayed request against itself, with the phone's own paired token. Revoking a
  phone (`loom clients --revoke`) works the same over the cloud.
- **The local admin bootstrap is refused over the relay.**
- Someone who learns your channel id still can't read or forge anything without
  the key.
