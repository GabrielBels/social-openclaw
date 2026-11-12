import process from "node:process";

// Reads one line from an interactive terminal without echoing it. Refuses to run without a TTY, so a value is never
// taken from a pipe, an argument or an agent's exec.
export function promptHidden(question, { input = process.stdin, output = process.stderr } = {}) {
  if (!input.isTTY) return Promise.reject(new Error("run this in an interactive terminal"));
  output.write(question);
  input.setRawMode(true);
  input.setEncoding("utf8");
  input.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (error) => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
      output.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = chunk => {
      for (const character of chunk) {
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u0003") return finish(new Error("cancelled"));
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else value += character;
      }
    };
    input.on("data", onData);
  });
}
