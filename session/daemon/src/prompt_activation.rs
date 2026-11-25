// Activation grants belong to one live operation and one provider identity.
// They are opaque to sessiond. Hyalo decides whether a grant can take focus.
use std::{
    collections::{HashMap, hash_map::Entry},
    sync::{Arc, Mutex},
};

type Key = (String, String);
type Entries = Arc<Mutex<HashMap<Key, Option<String>>>>;

#[derive(Clone, Default)]
pub struct Activations(Entries);

pub struct Operation {
    entries: Entries,
    key: Key,
}

impl Drop for Operation {
    fn drop(&mut self) {
        self.entries.lock().unwrap().remove(&self.key);
    }
}

impl Activations {
    pub fn bind(&self, owner: &str, target: &str, token: Option<String>) -> Option<Operation> {
        // Reserve even operations without a grant so a parallel caller cannot attach one.
        let key = (owner.into(), target.into());
        let mut entries = self.0.lock().unwrap();
        let Entry::Vacant(entry) = entries.entry(key.clone()) else {
            return None;
        };
        entry.insert(token.filter(|token| !token.is_empty() && token.len() <= 1024));
        Some(Operation {
            entries: self.0.clone(),
            key,
        })
    }

    pub fn take(&self, owner: &str, target: &str) -> Option<String> {
        self.0
            .lock()
            .unwrap()
            .get_mut(&(owner.into(), target.into()))?
            .take()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grant_is_issued_once_to_the_matching_operation() {
        let grants = Activations::default();
        let operation = grants.bind(":1.2", "uuid", Some("token".into())).unwrap();
        assert!(grants.bind(":1.2", "uuid", Some("other".into())).is_none());
        assert_eq!(grants.take(":1.3", "uuid"), None);
        assert_eq!(grants.take(":1.2", "other"), None);
        assert_eq!(grants.take(":1.2", "uuid").as_deref(), Some("token"));
        assert_eq!(grants.take(":1.2", "uuid"), None);
        drop(operation);
        let operation = grants
            .bind(":1.2", "uuid", Some("replacement".into()))
            .unwrap();
        drop(operation);
        assert_eq!(grants.take(":1.2", "uuid"), None);
    }
}
