
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

async function main() {
  const rl = createInterface({ input: stdin, output: stdout });

  try {
    const token = (
      await rl.question("Paste fresh provider access token: ")
    ).trim();

    const response = await fetch(
      "http://localhost:3000/api/medical-requests/6c1d7137-572e-4ce4-baa5-d5c69b688d5d/location",
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          latitude: -26.2041,
          longitude: 28.0473,
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

