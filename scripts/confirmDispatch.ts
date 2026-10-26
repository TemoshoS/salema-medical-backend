
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

async function main() {
  const rl = createInterface({ input: stdin, output: stdout });

  try {
    const token = (
      await rl.question("Paste your fresh control-room access token: ")
    ).trim();

    const response = await fetch(
      "http://localhost:3000/api/medical-requests/6c1d7137-572e-4ce4-baa5-d5c69b688d5d/status",
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      body: JSON.stringify({
  status: "ON_THE_WAY",
}),
      }
    );

    console.log("HTTP status:", response.status);
    console.log(await response.text());
  } catch (error) {
    console.error("Request failed:", error);
  } finally {
    rl.close();
  }
}

main();
