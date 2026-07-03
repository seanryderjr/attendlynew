# Attendly Simple

This is the cleaner Railway-friendly version. It removes Prisma, React build tooling, Vite, and hundreds of files.

## Railway setup

1. Push these files to GitHub with GitKraken.
2. Deploy the repo in Railway.
3. Add a Railway PostgreSQL database.
4. Add variables:

```text
DATABASE_URL=<Railway PostgreSQL public/internal connection string>
ADMIN_EMAIL=admin@attendly.local
ADMIN_PASSWORD=admin123!
```

Railway normally injects `DATABASE_URL` automatically when the Postgres database is attached.

Login:

```text
admin@attendly.local
admin123!
```

## Why this one should build easier

- Only 2 npm dependencies: `express` and `pg`
- No Prisma generate/migrate step
- No Vite/React build step
- Database tables are created automatically at startup
- Single backend serves the web app and API
