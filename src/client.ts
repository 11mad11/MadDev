import { Client, Connection } from "ssh2";
import { User } from "./gateway";

export class FullClient{

    constructor(
            public readonly incoming: IncomingClient,
            public readonly outgoing: OutgoingClient
    ){

    }

}

export class IncomingClient {

    constructor(
        public readonly connection: Connection,
        public readonly user: User
    ) {

    }

}

export class OutgoingClient {

    constructor(
        public readonly connection: Client,
        public readonly user: User
    ) {

    }

}