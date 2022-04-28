import "reflect-metadata" // this shim is required

import { Log, initLog } from "@perp/common/build/lib/loggers"
import { Container } from "typedi"

import { Maker } from "./maker/Maker"

initLog()

async function main(): Promise<void> {
    // crash fast on uncaught errors
    const exitUncaughtError = async (err: any): Promise<void> => {
        const log = Log.getLogger("main")
        try {
            await log.jerror({
                event: "UncaughtException",
                params: {
                    err,
                },
            })
        } catch (e: any) {
            console.log("exitUncaughtError error" + e.toString())
        }
        process.exit(1)
    }
    process.on("uncaughtException", err => exitUncaughtError(err))
    process.on("unhandledRejection", reason => exitUncaughtError(reason))

    const maker = Container.get(Maker)
    await maker.setup()
    await maker.start()
}

if (require.main === module) {
    main()
}
