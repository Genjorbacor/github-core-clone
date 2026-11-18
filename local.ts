// Local-only test entrypoint. NOT used by the grading harness: main.ts is the
// entry point there. This file exists only so the sealed local runner can be
// pointed at a server that is already listening on a fixed port.
import { createApp } from './app.ts';

const port = Number(process.env.PORT ?? '8090');
const server = createApp();
server.listen(port, '127.0.0.1', () => {
  console.log(`forge listening on http://127.0.0.1:${port}`);
});
