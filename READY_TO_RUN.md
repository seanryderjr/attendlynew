# Attendly Ready-to-Run Instructions

This version runs the complete Attendly app and PostgreSQL database together with Docker.

## 1. Install Docker Desktop

Install Docker Desktop for Mac or Windows and open it once.

## 2. Start Attendly

### Mac
Double-click or run:

```bash
./start-attendly.sh
```

### Windows
Double-click:

```text
start-attendly-windows.bat
```

## 3. Open the app

On the computer running Attendly:

```text
http://localhost:4000
```

Admin login:

```text
admin@attendly.local
admin123!
```

## 4. Use from other computers

Find the IP address of the computer running Attendly.

Then open this on employee/admin computers:

```text
http://YOUR-COMPUTER-IP:4000
```

Example:

```text
http://192.168.1.25:4000
```

All computers will share the same PostgreSQL database.

## 5. Stop Attendly

Mac:

```bash
./stop-attendly.sh
```

Windows:

```text
stop-attendly-windows.bat
```

## Notes

- Data is stored in the Docker volume named `attendly_pg`.
- Do not delete Docker volumes unless you intentionally want to erase Attendly data.
- Change the admin password before real use.
