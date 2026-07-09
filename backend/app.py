from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import psycopg2
import json


app = FastAPI()


# Allow frontend container/browser to call backend API
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:8080"
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

    origin:str
    destination:str



@app.post("/api/start")
def start(req:StartRequest):


    # Fake route for now
    # Minneapolis -> Chicago

    route=[
        [-93.265,44.977],
        [-92.5,44.8],
        [-91.5,44.4],
        [-90.2,43.8],
        [-88.0,41.9]
    ]


    conn=db()
    cur=conn.cursor()


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
    ))


    vehicle_id=cur.fetchone()[0]

    conn.commit()

    return {

        "id":vehicle_id,

        "position":route[0]
    }




@app.get("/api/vehicle/{id}")
def vehicle(id:int):


    conn=db()
    cur=conn.cursor()


    cur.execute(
    """
    SELECT route,current_index
    FROM vehicles
    WHERE id=%s
    """,
    (id,)
    )


    route,index=cur.fetchone()

    route=json.loads(route)


    if index < len(route)-1:

        index+=1


        cur.execute(
        """
        UPDATE vehicles

        SET current_index=%s

        WHERE id=%s
        """,
        (index,id)
        )

        conn.commit()


        status="DRIVING"

    else:

        status="ARRIVED"



    return {

        "position":route[index],

        "status":status
    }

