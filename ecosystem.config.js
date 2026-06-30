module.exports = {
  apps: [{
    name: 'picofuri2',
    script: './src/index.js',
    cwd: '/home/picofuri2/picofuri2',
    env: { NODE_ENV: 'development' },
    max_memory_restart: '400M',
    restart_delay: 5000,
    error_file: './logs/error.log',
    out_file: './logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss'
  }]
};
