//! Golden corpus for `cloud.aws` (opt-in — must be enabled explicitly).
//!
//! Precision is the whole point: read verbs and resource names that merely
//! contain "delete" must pass, while genuinely irreversible operations must
//! block. The RDS snapshot carve-out (a delete WITH `--final-db-snapshot-
//! identifier` is recoverable → allowed) is tested explicitly.

use lfguard::builtins::builtin_packs;
use lfguard::engine::{Decision, Engine};
use lfguard::profile::select_active;

fn engine() -> Engine {
    let (packs, warnings) = builtin_packs();
    assert!(warnings.is_empty(), "built-in load warnings: {warnings:?}");
    Engine::new(select_active(packs, &["cloud.aws".to_string()]))
}

fn deny(e: &Engine, cmd: &str) -> (String, String) {
    match e.evaluate(cmd) {
        Decision::Deny { pack, reason, .. } => (pack, reason),
        other => panic!("expected DENY for {cmd:?}, got {other:?}"),
    }
}

#[test]
fn denies_destructive_aws_commands() {
    let e = engine();
    // (command, substring the reason must contain — proves the class is named)
    let cases = [
        // CloudFormation
        (
            "aws cloudformation delete-stack --stack-name prod",
            "stack",
        ),
        // S3 force-remove / recursive delete
        ("aws s3 rb s3://my-bucket --force", "bucket"),
        ("aws s3 rm s3://my-bucket/data --recursive", "object"),
        (
            "aws s3 rm s3://my-bucket --recursive --exclude '*.keep'",
            "object",
        ),
        // EC2 terminate
        (
            "aws ec2 terminate-instances --instance-ids i-0abc",
            "terminate",
        ),
        // RDS delete without a final snapshot
        (
            "aws rds delete-db-instance --db-instance-identifier prod",
            "snapshot",
        ),
        (
            "aws rds delete-db-instance --db-instance-identifier prod --skip-final-snapshot",
            "snapshot",
        ),
        (
            "aws rds delete-db-cluster --db-cluster-identifier prod",
            "snapshot",
        ),
        // DynamoDB
        ("aws dynamodb delete-table --table-name users", "table"),
        // IAM self-priv-esc shapes
        ("aws iam delete-role --role-name localflow-agent", "IAM"),
        ("aws iam delete-user --user-name svc", "IAM"),
        (
            "aws iam detach-role-policy --role-name r --policy-arn arn:aws:iam::aws:policy/Foo",
            "IAM",
        ),
        (
            "aws iam attach-role-policy --role-name r --policy-arn arn:aws:iam::aws:policy/AdministratorAccess",
            "AdministratorAccess",
        ),
        (
            "aws iam attach-user-policy --user-name u --policy-arn arn:aws:iam::aws:policy/AdministratorAccess",
            "AdministratorAccess",
        ),
        // Organizations
        ("aws organizations delete-organization", "Organizations"),
        ("aws organizations leave-organization", "Organizations"),
        (
            "aws organizations detach-policy --policy-id p-1 --target-id ou-1",
            "Organizations",
        ),
        // Catch-all — destructive long tail not covered by a specific rule
        (
            "aws lambda delete-function --function-name f",
            "destructive",
        ),
        ("aws ec2 delete-vpc --vpc-id vpc-1", "destructive"),
        ("aws ecs delete-service --service svc", "destructive"),
        // sudo-wrapped forms still denied (wrapper peeled before matching)
        (
            "sudo aws ec2 terminate-instances --instance-ids i-1",
            "terminate",
        ),
        // chained after a benign command
        (
            "cd infra && aws dynamodb delete-table --table-name t",
            "table",
        ),
    ];
    for (cmd, needle) in cases {
        let (pack, reason) = deny(&e, cmd);
        assert_eq!(pack, "cloud.aws", "for {cmd:?}");
        assert!(
            reason.contains(needle),
            "reason {reason:?} should mention {needle:?} for {cmd:?}"
        );
    }
}

#[test]
fn allows_safe_aws_commands() {
    let e = engine();
    let allow = [
        // read verbs
        "aws ec2 describe-instances",
        "aws s3 ls",
        "aws s3 ls s3://my-bucket",
        "aws cloudformation describe-stacks",
        "aws rds describe-db-instances",
        "aws dynamodb describe-table --table-name users",
        "aws dynamodb list-tables",
        "aws iam list-roles",
        "aws iam get-role --role-name r",
        "aws organizations list-accounts",
        "aws organizations describe-organization",
        // an RDS delete that keeps a final snapshot is recoverable → allowed
        "aws rds delete-db-instance --db-instance-identifier prod --final-db-snapshot-identifier snap-1",
        "aws rds delete-db-cluster --db-cluster-identifier c --final-db-snapshot-identifier snap-2",
        // "delete" as a substring of a resource NAME / value, not the operation
        "aws ec2 describe-instances --filters Name=tag:Name,Values=delete-me",
        "aws s3 ls s3://delete-me",
        "aws s3 cp file.txt s3://delete-me/file.txt",
        // single-object S3 delete without --recursive is not blanket-blocked
        "aws s3 rm s3://my-bucket/one-object.txt",
        // benign IAM attach (not AdministratorAccess)
        "aws iam attach-role-policy --role-name r --policy-arn arn:aws:iam::aws:policy/ReadOnlyAccess",
        // an undelete/restore verb must not trip the delete catch-all
        "aws route53domains list-domains",
    ];
    for cmd in allow {
        assert!(
            !e.evaluate(cmd).is_deny(),
            "expected ALLOW for {cmd:?}, got DENY"
        );
    }
}

/// The RDS snapshot boundary on its own: identical delete, snapshot flag flips
/// the verdict. The near-miss the spec (§10) calls out explicitly.
#[test]
fn rds_snapshot_boundary() {
    let e = engine();
    assert!(
        e.evaluate("aws rds delete-db-instance --db-instance-identifier prod")
            .is_deny(),
        "un-snapshotted RDS delete must DENY"
    );
    assert!(
        !e.evaluate(
            "aws rds delete-db-instance --db-instance-identifier prod --final-db-snapshot-identifier snap-1"
        )
        .is_deny(),
        "snapshotted RDS delete must ALLOW"
    );
}
