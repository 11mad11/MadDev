import { DataType, load, open } from "ffi-rs";

// Initialize APIs
try {
    open({ library: 'libnl', path: '/lib/x86_64-linux-gnu/libnl-3.so.200' });
} catch (error) {
    console.error('Failed to load:', error);
    process.exit(1);
}

const def = {
    library: "libnl",
    errno: false,
    freeResultMemory: false,
    runInNewThread: false
} as const;

//https://github.com/thom311/libnl/blob/6bd2bd65015302e6d59e02d1dd35ee5126d633e1/include/netlink/netlink-kernel.h#L16
const sockaddr_nl = {
    /** socket family (AF_NETLINK) */
    nl_family: DataType.I32,

    /** Padding (unused) */
    nl_pad: DataType.I16,

    /** Unique process ID  */
    nl_pid: DataType.I32,

    /** Multicast group subscriptions */
    nl_groups: DataType.I32
}

//https://github.com/thom311/libnl/blob/6bd2bd65015302e6d59e02d1dd35ee5126d633e1/include/nl-priv-dynamic-core/nl-core.h#L15
const nl_sock = {
    s_local: sockaddr_nl,
    s_peer: sockaddr_nl,
    s_fd: DataType.I32,
    s_proto: DataType.I32,
    s_seq_next: DataType.I32,
    s_seq_expect: DataType.I32,
    s_flags: DataType.I32,
    /*struct nl_cb *s_cb;
	size_t s_bufsize;*/
}

export default {
    nl_sock,
    nl_socket_alloc() {
        return load({
            ...def,
            funcName: "nl_socket_alloc",
            paramsType: [],
            retType: DataType.External,
            paramsValue: []
        })
    }
}

/*
const libnl = ffi.Library('libnl-3', {
  'nl_socket_alloc': [VoidPtr, []], // struct nl_sock *nl_socket_alloc(void);
  'nl_socket_free': ['void', [VoidPtr]], // void nl_socket_free(struct nl_sock *sk);
  'genl_connect': ['int', [VoidPtr]], // int genl_connect(struct nl_sock *sock);
  'rtnl_link_alloc_cache': ['int', [VoidPtr, IntPtr]], // int rtnl_link_alloc_cache(struct nl_sock *sk, struct nl_cache **cache);
  'rtnl_link_get_name': ['string', [VoidPtr]], // const char *rtnl_link_get_name(struct rtnl_link *link);
  'rtnl_link_get': [VoidPtr, [VoidPtr, IntPtr]], // struct rtnl_link *rtnl_link_get(struct nl_cache *cache, int ifindex);
  'rtnl_link_i2name': ['string', [VoidPtr, 'int', 'string', 'int']], // int rtnl_link_i2name(struct nl_sock *sk, int ifindex, char *name, size_t len);
  'nl_cache_foreach': ['void', [VoidPtr, VoidPtr, VoidPtr]], // void nl_cache_foreach(struct nl_cache *cache, nl_cache_foreach_func_t cb, void *arg);
  'nl_cache_free': ['void', [VoidPtr]] // void nl_cache_free(struct nl_cache *cache);
});
*/