import asyncio
from logging.config import fileConfig

from alembic import context
from sqlalchemy.ext.asyncio import create_async_engine

from core.config import settings
from database import models  # noqa: F401  (register models)
from database.base import Base

config = context.config
if config.config_file_name:
    fileConfig(config.config_file_name)
target_metadata = Base.metadata

# Tables owned by LangGraph's Postgres checkpointer (created by AsyncPostgresSaver.setup()); never let
# autogenerate drop or alter them.
EXTERNAL_TABLE_PREFIXES = ("checkpoint",)


def include_object(obj, name, type_, reflected, compare_to):  # noqa: ANN001
    table = obj.table.name if type_ in ("index", "column", "unique_constraint", "foreign_key_constraint") else name
    if reflected and compare_to is None and str(table).startswith(EXTERNAL_TABLE_PREFIXES):
        return False
    return True


def run_migrations_offline() -> None:
    context.configure(url=settings.database_url, target_metadata=target_metadata, literal_binds=True,
                      include_object=include_object)
    with context.begin_transaction():
        context.run_migrations()


def _do_run(connection) -> None:
    context.configure(connection=connection, target_metadata=target_metadata, compare_type=True,
                      include_object=include_object)
    with context.begin_transaction():
        context.run_migrations()


async def run_migrations_online() -> None:
    engine = create_async_engine(settings.database_url)
    async with engine.connect() as connection:
        await connection.run_sync(_do_run)
    await engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    asyncio.run(run_migrations_online())
