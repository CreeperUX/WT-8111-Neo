fn main() {
    prost_build::Config::new()
        .compile_protos(
            &[
                "protos/observation.proto",
                "protos/snapshot.proto",
                "protos/envelope.proto",
            ],
            &["protos/"],
        )
        .expect("Failed to compile protobuf schemas");
}
