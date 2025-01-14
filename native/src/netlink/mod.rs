use bridge::Bridge;
use futures::stream::TryStreamExt;
use napi_derive::napi;
use netlink_packet_route::link::LinkAttribute;
use rtnetlink::{new_connection, Handle};

mod bridge;

#[napi]
pub struct NetLink {
    handle: Handle,
}

#[napi]
impl NetLink {
    #[napi(constructor)]
    pub fn new() -> Self {
        let (connection, handle, _) = new_connection().unwrap();
        tokio::spawn(connection);
        NetLink { handle }
    }

    /*#[napi]
    pub async fn create_tap(&self,name: String){
        //ip tuntap add dev tap0 mode tap
        self.handle.link().add().name(name).kind
    }*/

    #[napi]
    pub async fn create_bridge(&self, name: String) -> Result<Bridge, napi::Error> {
        Bridge::new(self, name).await.map_err(|e| e.into())
    }

    #[napi]
    pub async fn dump_links(&self) -> Result<Vec<String>, napi::Error> {
        let mut links = self.handle.link().get().execute();
        let mut ret = Vec::new();
        'outer: loop {
            let msg = links.try_next().await;

            let msg = match msg {
                Err(err) => {
                    return Err(napi::Error::new(
                        napi::Status::GenericFailure,
                        err.to_string(),
                    ))
                }
                Ok(msg) => msg,
            };

            let msg = match msg {
                None => break 'outer,
                Some(msg) => msg,
            };

            for nla in msg.attributes.into_iter() {
                if let LinkAttribute::IfName(name) = nla {
                    //println!("found link {} ({})", msg.header.index, name);
                    ret.push(format!("link {} ({})", msg.header.index, name));
                    continue 'outer;
                }
            }
            eprintln!("found link {}, but the link has no name", msg.header.index);
        }
        Ok(ret)
    }
}
