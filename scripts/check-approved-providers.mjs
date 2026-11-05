import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

const rl = readline.createInterface({ input: stdin, output: stdout });

try {
  const email = (await rl.question("Control Room email: ")).trim();
  const password = await rl.question("Control Room password: ");
  const base = "http://192.168.1.4:3000/api";

  const loginResponse = await fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  const loginData = await loginResponse.json();

  if (!loginResponse.ok || !loginData.success) {
    console.log("Login failed:", loginData.message || loginResponse.status);
    process.exitCode = 1;
  } else {
    const token =
      loginData.token ??
      loginData.accessToken ??
      loginData.data?.token ??
      loginData.data?.accessToken;

    if (!token) {
      console.log("Login succeeded, but no recognised token field was found.");
      console.log("Response keys:", Object.keys(loginData));
      process.exitCode = 1;
    } else {
      const response = await fetch(
        `${base}/medical-requests/providers/approved`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const data = await response.json();

      console.log("\nHTTP status:", response.status);
      console.log("Provider count:", data.count ?? data.providers?.length ?? "unknown");

      for (const p of data.providers ?? []) {
        console.log({
          fullName: p.fullName,
          providerType: p.providerType,
          serviceArea: p.serviceArea,
        });
      }

      console.log(
        "\nIndividual driver present:",
        (data.providers ?? []).some(
          p => p.providerType === "INDIVIDUAL_DRIVER"
        )
      );
    }
  }
} catch (error) {
  console.error("Request failed:", error.message);
  process.exitCode = 1;
} finally {
  rl.close();
}
