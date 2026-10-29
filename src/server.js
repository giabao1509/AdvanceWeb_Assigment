import { createApp } from './app.js';
const app = createApp();
const port = Number(process.env.PORT || 3000);
const server = app.listen(port, '127.0.0.1', () => console.log(`Task Authorization Lab: http://127.0.0.1:${port}`));
server.on('error', error => { console.error(error.message); app.locals.db.close(); process.exitCode = 1; });
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => server.close(() => { app.locals.db.close(); process.exit(0); }));
