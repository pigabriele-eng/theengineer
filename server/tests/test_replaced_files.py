"""A stored file a row no longer names (traces or technique details made again) is deleted, so it stops taking
storage."""


def test_a_replaced_stored_file_is_deleted_and_the_new_one_kept(client):
    from app import storage
    from app.routers import reports

    old, new = storage.save(b"old", ".npz"), storage.save(b"new", ".npz")
    reports.forget_file(old, new)
    assert not storage.local_path(old).exists()
    assert storage.local_path(new).read_bytes() == b"new"

    reports.forget_file(new, new)  # the same file: kept
    reports.forget_file(None, new)  # nothing kept before
    reports.forget_file(old, None)  # already gone: nothing happens
    assert storage.local_path(new).exists()
