use futures::TryStreamExt;
use napi_derive::napi;
use netlink_packet_route::link::LinkMessage;
use rtnetlink::Handle;

use crate::Error;

use super::NetLink;

#[napi]
pub struct Bridge {
    handle: Handle,
    info: LinkMessage,
    pub name: String,
}

#[napi]
impl Bridge {
    pub async fn new(netlink: &NetLink, name: String) -> Result<Self, Error> {
        netlink
            .handle
            .link()
            .add()
            .bridge(name.clone())
            .execute()
            .await?;

        let info = netlink
            .handle
            .link()
            .get()
            .match_name(name.clone())
            .execute()
            .try_next()
            .await?;

        match info {
            None => Err(Error::new(
                "Could not retrieve index of the bridge".to_string(),
            )),
            Some(info) => Ok(Bridge {
                handle: netlink.handle.clone(),
                info,
                name,
            }),
        }
    }

    #[napi]
    pub async fn up(&self) -> Result<(), napi::Error> {
        self.handle
            .link()
            .set(self.info.header.index)
            .up()
            .execute()
            .await
            .map_err(Error::convert)
    }
}
