import {
  access,
} from "node:fs/promises";
import path from "node:path";
import {
  spawn,
  spawnSync,
} from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(scriptDirectory, "..");

function javaMajorVersion(environment) {
  const result = spawnSync("java", ["-version"], {
    encoding: "utf8",
    env: environment,
  });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  const match = output.match(/version "(\d+)/);
  return match ? Number(match[1]) : 0;
}

async function existingDirectory(candidates) {
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next common JDK location.
    }
  }
  return "";
}

export async function java21Environment(baseEnvironment = process.env) {
  const environment = { ...baseEnvironment };
  if (javaMajorVersion(environment) >= 21) return environment;

  const javaHome = await existingDirectory([
    "/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home",
    "/usr/local/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home",
  ]);
  if (!javaHome) {
    throw new Error("Firebase emulator tests require Java 21 or newer.");
  }
  environment.JAVA_HOME = javaHome;
  environment.PATH = `${path.join(javaHome, "bin")}${path.delimiter}${environment.PATH || ""}`;
  if (javaMajorVersion(environment) < 21) {
    throw new Error("Could not start Java 21 for Firebase emulator tests.");
  }
  return environment;
}

export function parseArguments(args) {
  const separator = args.indexOf("--");
  if (separator < 0 || separator === args.length - 1) {
    throw new Error(
      "Usage: run-emulator-test.mjs [firebase args] -- <test command>",
    );
  }
  return {
    firebaseArguments: args.slice(0, separator),
    testCommand: args.slice(separator + 1).join(" "),
  };
}

export async function runEmulatorTest(args) {
  const { firebaseArguments, testCommand } = parseArguments(args);
  const environment = await java21Environment();
  const firebaseExecutable = path.join(
    workspace,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "firebase.cmd" : "firebase",
  );
  const child = spawn(
    firebaseExecutable,
    [
      "emulators:exec",
      "--project",
      "demo-rgleaderboard",
      "--only",
      "firestore",
      ...firebaseArguments,
      testCommand,
    ],
    {
      cwd: workspace,
      env: environment,
      stdio: "inherit",
      shell: false,
    },
  );
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`Firebase emulator stopped with signal ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

const isEntryPoint =
  process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntryPoint) {
  runEmulatorTest(process.argv.slice(2))
    .then(code => {
      process.exitCode = code;
    })
    .catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
