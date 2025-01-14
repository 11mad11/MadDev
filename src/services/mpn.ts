import { TcpipBindInfo, AcceptConnection, ServerChannel, TcpipRequestInfo } from "ssh2";
import { Service, User } from "../gateway";
import { utils } from "iproute";
import { createServer } from "net";
import { execFileSync, spawn } from "child_process";
import { chmodSync, existsSync, unlinkSync } from "fs";
import camelcase from "camelcase";
import { NetNS } from "../utils/NetNS";
import { NetLink } from "../../native";

//https://john-millikin.com/creating-tun-tap-interfaces-in-linux

export class MyPrivateNetworkService implements Service<any> {
    services = new Map<string, MyPrivateNetwork>();
    async register(ctx: { user: User; info: TcpipBindInfo; }) {
        throw new Error();
    }

    async addNetwork(name: string) {
        if (name.indexOf(" ") !== -1)
            throw new Error("no space in name");
        const mpn = new MyPrivateNetwork(name);
        this.services.set(name, mpn);
        return mpn;
    }

    async use(ctx: {
        user: User,
        accept: AcceptConnection<ServerChannel>,
        info: TcpipRequestInfo
    }) {
        throw new Error("Not implemented")
    }

}

class MyPrivateNetwork{
    ns: NetNS;
    netlink: NetLink;

    constructor(
        public readonly name: string
    ){
        this.ns = new NetNS(()=>{
            this.netlink = new NetLink();
        });
    }

}