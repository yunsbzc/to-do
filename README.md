# To Do

A minimal to-do, reading list and countdown app. Plain HTML, CSS and JavaScript, no build step.

Live at **https://yunsbzc.github.io/to-do/**

Everything is saved in your browser. To sync between devices, connect a free Supabase project (about 15 minutes, once).

## Turning on sync

1. **Create a project.** Sign up at [supabase.com](https://supabase.com), then create a new project (any name, any region near you, and save the database password somewhere safe).
2. **Create the table.** In the project, open **SQL Editor**, start a new query, paste the contents of [`supabase.sql`](supabase.sql) and press **Run**.
3. **Allow the sign-in link back to the app.** Open **Authentication → URL Configuration**:
   - **Site URL:** `https://yunsbzc.github.io/to-do/`
   - **Redirect URLs:** add `https://yunsbzc.github.io/to-do/`
4. **Connect the app.** Open **Project Settings → API Keys** (or **API**). Copy the **Project URL** and the **publishable** key (called the **anon** key on older projects) into [`config.js`](config.js), then commit and push. Both are safe to publish: the rules in `supabase.sql` mean each person can only read and change their own lists.
5. **Sign in.** On the site, tap **Sign in to sync** at the bottom, enter your email and open the link it sends you on that same device. Do the same on your other devices. Lists already on a device are merged in, not replaced.

Optional: once all your devices are signed in, you can turn off **Authentication → Sign In / Providers → Allow new users to sign up**, so nobody else can create an account on your project.

## How sync works

- Each device keeps working offline and saves locally first. It syncs when you open the app, when you come back to it, a moment after each change, and every minute while it's open.
- Every to-do, list and countdown records when it was last changed. When two devices both changed things, the newest version of each one wins, so edits to different things never overwrite each other.
- Deleted things leave a small marker, so a deletion on one device isn't undone by an older copy on another.
- Signing out keeps your lists on that device; they just stop syncing.

Supabase's built-in email service sends only a few sign-in emails per hour. That is plenty for personal use; if a link doesn't arrive, wait a little and try again.
