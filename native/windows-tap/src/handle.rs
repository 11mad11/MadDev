//! Opaque-handle registry. Maps u64 → backend state. Handle space
//! starts at 1 so the C ABI can use 0 as "invalid / error".
//!
//! Each slot pairs an Arc<dyn Backend> (wintun or tap-windows6) with
//! an optional running Pump.

use std::collections::HashMap;
use std::sync::Arc;

use crate::backend::Backend;
use crate::pump::Pump;

pub struct Slot {
    backend: Arc<dyn Backend>,
    pump: Option<Pump>,
}

impl Slot {
    pub fn new(backend: Arc<dyn Backend>) -> Self {
        Self { backend, pump: None }
    }

    pub fn backend(&self) -> Arc<dyn Backend> {
        self.backend.clone()
    }

    pub fn has_pump(&self) -> bool {
        self.pump.is_some()
    }

    pub fn pump(&self) -> Option<&Pump> {
        self.pump.as_ref()
    }

    pub fn set_pump(&mut self, p: Pump) {
        self.pump = Some(p);
    }

    pub fn take_pump(&mut self) -> Option<Pump> {
        self.pump.take()
    }
}

pub struct HandleRegistry {
    next: u64,
    slots: HashMap<u64, Slot>,
}

impl HandleRegistry {
    pub fn new() -> Self {
        Self { next: 1, slots: HashMap::new() }
    }

    pub fn insert(&mut self, slot: Slot) -> u64 {
        let id = self.next;
        self.next = self.next.wrapping_add(1);
        if self.next == 0 {
            self.next = 1;
        }
        self.slots.insert(id, slot);
        id
    }

    pub fn get(&self, id: u64) -> Option<&Slot> {
        self.slots.get(&id)
    }

    pub fn get_mut(&mut self, id: u64) -> Option<&mut Slot> {
        self.slots.get_mut(&id)
    }

    pub fn remove(&mut self, id: u64) -> Option<Slot> {
        self.slots.remove(&id)
    }
}
