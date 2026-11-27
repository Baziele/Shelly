// Preloaded into the fake agent: an agent whose shutdown hangs, like claude-agent-acp,
// whose SIGTERM and stdin-EOF handlers both `await acp.dispose()` before exiting.
process.on('SIGTERM', () => {});
process.exit = () => {
  setInterval(() => {}, 1000);
};
