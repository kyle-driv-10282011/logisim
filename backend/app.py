from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import psycopg2
import json


app = FastAPI()


# Allow frontend browser to call backend API
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:8700"
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def db():

    return psycopg2.connect(
        "dbname=vehicle_sim "
        "user=simulator "
        "password=simulator_password "
        "host=postgres"
    )



class StartRequest(BaseModel):

    origin: str
    destination: str



@app.post("/api/start")
def start(req: StartRequest):

    #
    # Fake route for now
    #
    # Leaflet uses:
    # [latitude, longitude]
    #

    route = [

        [44.977, -93.265],   # Minneapolis

        [44.800, -92.500],

        [44.400, -91.500],

        [43.800, -90.200],

        [41.900, -88.000]    # Chicago

    ]


    conn = db()
    cur = conn.cursor()


    cur.execute(
        """
        INSERT INTO vehicles
        (
            origin,
            destination,
            route
        )

        VALUES
        (%s,%s,%s)

        RETURNING id
        """,
        (
            req.origin,
            req.destination,
            json.dumps(route)
        )
    )


    vehicle_id = cur.fetchone()[0]

    conn.commit()

    cur.close()
    conn.close()


    return {

        "id": vehicle_id,

        "position": route[0],

        "route": route
    }





@app.get("/api/vehicle/{id}")
def vehicle(id:int):


    conn = db()
    cur = conn.cursor()


    cur.execute(
        """
        SELECT route,current_index
        FROM vehicles
        WHERE id=%s
        """,
        (id,)
    )


    route,index = cur.fetchone()


    if index < len(route)-1:

        index += 1


        cur.execute(
            """
            UPDATE vehicles

            SET current_index=%s,
                updated=NOW()

            WHERE id=%s
            """,
            (index,id)
        )

        conn.commit()

        status = "DRIVING"


    else:

        status = "ARRIVED"



    cur.close()
    conn.close()


    return {

        "position": route[index],

        "status": status

    }