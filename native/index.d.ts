/* tslint:disable */
/* eslint-disable */

/* auto-generated by NAPI-RS */

export declare class Bridge {
  name: string
  up(): Promise<void>
}
export declare class NetLink {
  constructor()
  createBridge(name: string): Promise<Bridge>
  dumpLinks(): Promise<Array<string>>
}