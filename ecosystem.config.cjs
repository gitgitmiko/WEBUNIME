module.exports = {
  apps: [
    {
      name: "webunime",
      cwd: "/www/wwwroot/webunime",
      script: "server/app.js",
      interpreter: "/www/server/nodejs/v24.11.1/bin/node",
      env: {
        NODE_ENV: "production",
        PATH: "/www/server/nodejs/v24.11.1/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      },
      max_memory_restart: "400M",
      restart_delay: 3000,
    },
  ],
};
