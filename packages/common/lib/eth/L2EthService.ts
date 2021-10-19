import { Service } from "typedi"

import { EthService } from "./EthService"

@Service()
export class L2EthService extends EthService {
    constructor() {
        const endpoint = process.env.L2_WEB3_ENDPOINT
        if (!endpoint) {
            throw Error("no env L2_WEB3_ENDPOINT is provided")
        }
        super("layer2", [endpoint])
    }
}
