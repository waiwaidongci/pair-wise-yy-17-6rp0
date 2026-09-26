const fs = require('fs/promises');

// 存储层：只负责 db.json 的读写与并发串行化，不含任何业务判定。
// mutate(fn) 把「读-改-写」串进同一条 Promise 队列，
// 两人同时上报时请求依次落库，不会互相覆盖丢数。
function createStore(file) {
  let queue = Promise.resolve();

  async function read() {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw);
  }

  async function write(db) {
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(db, null, 2) + '\n');
    await fs.rename(tmp, file);
  }

  function mutate(fn) {
    const run = queue.then(async () => {
      const db = await read();
      const result = await fn(db);
      // 业务校验失败（返回 { error }）时不落库，保持原数据不变
      if (result && result.error) return result;
      await write(db);
      return result;
    });
    queue = run.catch(() => {});
    return run;
  }

  return { read, mutate };
}

module.exports = { createStore };
