use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::{Signer, SigningKey};
use fleet_agent::protocol::Task;
use serde_json::Value;

#[test]
fn shared_canonical_task_fixture_matches() {
    let f: Value = serde_json::from_str(include_str!(
        "../../contracts/v1/fixtures/canonical-task.json"
    ))
    .unwrap();
    let task: Task = serde_json::from_value(f["task"].clone()).unwrap();
    assert_eq!(task.hash(), f["payload_hash"].as_str().unwrap());
    let mut v = serde_json::to_value(&task).unwrap();
    v.as_object_mut().unwrap().remove("payload_hash");
    assert_eq!(
        serde_json::to_string(&v).unwrap(),
        f["canonical_utf8"].as_str().unwrap()
    );
    task.validate(&task.device_id).unwrap();
}
#[test]
fn shared_challenge_signatures_match() {
    let f: Value = serde_json::from_str(include_str!(
        "../../contracts/v1/fixtures/challenge-signatures.json"
    ))
    .unwrap();
    let seed = hex::decode(f["seed_hex"].as_str().unwrap()).unwrap();
    let key = SigningKey::from_bytes(&seed.try_into().unwrap());
    for c in f["cases"].as_array().unwrap() {
        let bytes = STANDARD
            .decode(c["response"]["signing_payload"].as_str().unwrap())
            .unwrap();
        assert_eq!(
            String::from_utf8(bytes.clone()).unwrap(),
            c["signing_payload_utf8"].as_str().unwrap()
        );
        assert_eq!(
            STANDARD.encode(key.sign(&bytes).to_bytes()),
            c["signature"].as_str().unwrap()
        );
    }
}
