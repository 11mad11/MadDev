#![deny(clippy::all)]

mod netlink;

pub struct Error(napi::Error);

impl Error{
  #[allow(dead_code)]
  pub fn new(err: String)->Self{
    Error(napi::Error::new(napi::Status::GenericFailure, err))
  }

  pub fn convert(err: rtnetlink::Error) -> napi::Error{
    Error::from(err).into()
  }
}

impl From<rtnetlink::Error> for Error {
  fn from(err: rtnetlink::Error) -> Self {
      Error(napi::Error::new(napi::Status::GenericFailure, err.to_string()))
  }
}

impl From<napi::Error> for Error {
  fn from(err: napi::Error) -> Self {
      Error(err)
  }
}

impl Into<napi::Error> for Error {
  fn into(self) -> napi::Error {
      self.0
  }
}