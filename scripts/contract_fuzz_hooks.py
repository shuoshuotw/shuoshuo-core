import random

import schemathesis


@schemathesis.hook
def before_call(context, case, **kwargs):
    # A new address per call, so the per-IP AUTH-GUARD does not hide the routes behind 429s
    case.headers["CF-Connecting-IP"] = f"10.{random.randrange(255)}.{random.randrange(255)}.{random.randrange(255)}"
