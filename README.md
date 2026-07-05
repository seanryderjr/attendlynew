# Attendly Stable React + Express

This is the simplified stable Railway build. It uses:
- Express backend
- PostgreSQL database
- React frontend served from `public/index.html`
- No Vite, Prisma, nested packages, or multi-step build

## Railway variables
Set these on the app service:

```
DATABASE_URL=${{Postgres.DATABASE_URL}}
JWT_SECRET=make-this-long-and-random
ADMIN_EMAIL=admin@attendly.local
ADMIN_PASSWORD=admin123!
NODE_ENV=production
```

Default login:

```
admin@attendly.local
admin123!
```

If login fails, open `/reset-admin?key=YOUR_JWT_SECRET` in your browser once.
