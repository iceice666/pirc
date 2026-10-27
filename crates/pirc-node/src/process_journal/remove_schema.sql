-- Test fixtures only: reconstruct the earlier schema before migration.
DROP TRIGGER sandbox_launch_identity; DROP TRIGGER sandbox_kernel_identity; DROP TRIGGER sandbox_launch_terminal; DROP TRIGGER sandbox_launch_retained; DROP TABLE sandbox_launches;
