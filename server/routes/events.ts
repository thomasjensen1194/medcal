import express from "express";
import Event from "models/eventsModel";
import moment from "moment";
import { populateEvents } from "jobs/populateEvents";
const Router = express.Router();

Router.get("/", async (req, res) => {
  try {
    let {
      year,
      season,
      semester,
      team,
      sortby,
      sortBy,
      type,
      order,
      start,
      end,
      id,
      whereEndBetween,
      nextEvent
    } = req.query;

    if (start) start = moment(start).format("YYYY-MM-DD HH:mm:ss");
    if (end) end = moment(end).format("YYYY-MM-DD HH:mm:ss");

    if (id) {
      const result = await Event.query().findById(id);
      return res.status(200).json(result);
    }
    if (nextEvent) {
      if (!start || !end)
        return res
          .status(400)
          .send("You must specify start and end, when getting next event");
      const result = await Event.query()
        .where("team", "=", team)
        .andWhere("semester", "=", semester)
        .andWhere(function() {
          this.whereBetween("end", [start, end]).orWhere("end", ">=", start);
        })
        .orderBy("start", "asc")
        .first();
      return res.status(200).json(result);
    }

    let resultQuery = Event.query()
      .joinEager("[teams, teachers]")
      .where({
        "events.year": year,
        "events.season": season,
        "events.semester": semester,
        type: type,
        team: team
      })
      .skipUndefined();

    if (whereEndBetween && start && end) {
      resultQuery = resultQuery.whereBetween("end", [start, end]);
    }
    if (start && !whereEndBetween) {
      resultQuery = resultQuery.where("start", ">=", start);
    }
    if (end && !whereEndBetween) {
      resultQuery = resultQuery.where("end", "<=", end);
    }

    if (sortBy || sortby) {
      resultQuery = resultQuery.orderBy(sortBy || sortby, order || "asc");
    } else {
      resultQuery = resultQuery.orderBy("start");
    }

    const result = await resultQuery;

    res.status(200).json(result);
  } catch (error) {
    console.error(error);
    res.status(404).send(error);
  }
});

Router.get("/populate", async (req, res) => {
  populateEvents();

  res.status(200).send("Running population");
});

export default Router;
