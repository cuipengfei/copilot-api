import { getDevDeviceId, getMachineId } from "~/services/telemetry/identity"

process.stdout.write("ready\n")
await Bun.stdin.text()
process.stdout.write(
  JSON.stringify({ machineId: getMachineId(), deviceId: getDevDeviceId() })
    + "\n",
)
