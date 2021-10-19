import "reflect-metadata" // this shim is required

import { initLog } from "@perp/common/build/lib/loggers"
import { Container } from "typedi"

import { Maker } from "./maker/Maker"

initLog()

async function main(): Promise<void> {
    const maker = Container.get(Maker)
    await maker.setup()
    await maker.start()
}

if (require.main === module) {
    main()
}
