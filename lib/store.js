// 存储层：负责 db.json 的读写。
// 所有修改通过串行事务执行——并发上报排队落库，两人同时上报也不丢数。
const fs = require('fs/promises');

class Store {
  constructor(file) {
    this.file = file;
    this.queue = Promise.resolve();
  }

  async read() {
    const raw = await fs.readFile(this.file, 'utf8');
    return JSON.parse(raw);
  }

  async write(db) {
    await fs.writeFile(this.file, JSON.stringify(db, null, 2) + '\n');
  }

  // 串行事务：fn 返回 false 时放弃写入（用于校验失败等场景）
  transact(fn) {
    const run = this.queue.then(async () => {
      const db = await this.read();
      const result = await fn(db);
      if (result !== false) await this.write(db);
      return result;
    });
    this.queue = run.catch(() => {});
    return run;
  }
}

module.exports = { Store };
