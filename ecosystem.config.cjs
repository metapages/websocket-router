/**
 * pm2 process definition.
 *
 * Deliberately a single instance in fork mode, not cluster mode. The router's
 * entire state is the in-memory map of channel names to sockets, so a second
 * worker would be a second, separate router: two clients on the same channel
 * would land on different workers and never hear each other. Cluster mode
 * here would not be a performance win, it would be a correctness bug.
 *
 * Scaling is therefore vertical. One Node process handles tens of thousands
 * of idle websockets; if you genuinely outgrow one box, run a second host as
 * its own router on its own hostname (which is what `deploy/deploy.sh` does)
 * rather than putting two behind one name.
 */
module.exports = {
  apps: [
    {
      name: "websocket-router",
      script: "dist/server/index.js",
      cwd: "/opt/websocket-router/current",
      instances: 1,
      exec_mode: "fork",

      // The server writes its own rotated JSON logs under DATA_DIR/logs; pm2
      // captures stdout as well, which `pm2 logs` shows. pm2-logrotate (set
      // up by bootstrap.sh) keeps that copy bounded too.
      time: true,
      merge_logs: true,
      out_file: "/var/log/websocket-router/pm2-out.log",
      error_file: "/var/log/websocket-router/pm2-error.log",

      // Restart on crash, but give up if it is crash-looping: a bad deploy
      // should leave an obviously stopped process and a clear log, not a
      // process thrashing quietly for hours.
      autorestart: true,
      max_restarts: 10,
      min_uptime: "30s",
      restart_delay: 2000,
      exp_backoff_restart_delay: 500,

      // The process holds long-lived websockets and a modest heap. This is a
      // backstop against a leak, not an expected event.
      max_memory_restart: "900M",

      // Give open connections a moment to close with 1001 "going away" so
      // clients reconnect immediately instead of backing off. Must exceed the
      // 10s shutdown guard in src/index.ts.
      kill_timeout: 12000,
      listen_timeout: 20000,
      wait_ready: false,

      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
