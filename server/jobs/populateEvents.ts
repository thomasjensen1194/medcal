import { CronJob } from "cron";
import ical from "ical";
import Event from "../models/events.model";
import _ from "lodash";
import TeamsEvents from "models/teamsEvents.model";
import Teacher from "models/teacher.model";
import EventsTeachers from "models/eventsTeachers.model";
import OtherEventsTeams from "models/otherEvents.model";
import EventChanges from "models/eventChanges.model";
import moment from "moment-timezone";

/**
 * Key: semester, value: team
 */
const semesters = {
  7: 8,
  8: 16,
  9: 8,
  10: 16,
  11: 12,
  12: 12
};

/**
 * All locations are auditoriums on Skejby University Hospital
 */
const getLocationId = (event: Event) => {
  if (event.location.match(/aud a|auditorium a/i)) return "A";
  if (event.location.match(/aud b|auditorium b/i)) return "B";
  if (event.location.match(/aud c|auditorium c/i)) return "C";
  if (event.location.match(/aud j|auditorium j/i)) return "J";

  return null;
};

/**
 * Returns F for spring (forår) and E for autumn (efterår)
 */
const calculateSeason = () => {
  const now = new Date().getMonth();

  if (now < 6) {
    return "F";
  } else {
    return "E";
  }
};

/**
 * Returns the two last digits of the current year
 */
const calculateYear = () => {
  return Number(
    new Date()
      .getFullYear()
      .toString()
      .substr(2)
  );
};

const getEventId = (event: any, semester: number) => {
  if (event.title.match(/F\d+:/i)) {
    return (
      calculateSeason() +
      calculateYear() +
      appendZero(semester.toString()) +
      appendZero(event.title.split(/F(\d+):/i)[1])
    );
  } else {
    return null;
  }
};

const getTypeFromEvent = (event: any) => {
  if (event.title.match(/intro/i)) return "intro";
  if (event.title.match(/F\d+:/i)) return "lecture";
  return "unknown";
};

const appendZero = (string: string) => {
  return string.length === 1 ? `0${string}` : string;
};

export const compareEvents = async (
  event: any,
  exists?: any
): Promise<Event | undefined> => {
  try {
    // Sammenligning
    const picks = ["title", "description", "location", "start", "end"]; // Hvilke værdier der sammenlignes blandt
    const compareEvent = _.pick(event, picks);
    const compareExists = _.pick(exists, picks);

    // Hvis eventet eksisterer, men har ændret sig
    if (exists && !_.isEqual(compareEvent, compareExists)) {
      const changedValues: Partial<Event> = _.omitBy(
        compareEvent,
        (event, index) => _.isEqual(compareExists[index], event)
      );
      // Check om der var nogle værdier der havde ændret sig
      if (!_.isEmpty(changedValues) && event.lectureId) {
        for (let change in changedValues) {
          await EventChanges.query().insert({
            param: change,
            lectureId: exists.lectureId,
            eventId: exists.id,
            old: exists[change],
            new: changedValues[change],
            title: exists.title
          });
        }
      }
      return Event.query().updateAndFetchById(exists.id, event);
    }

    // Hvis eventet ikke eksisterer
    if (!exists) {
      const result = await Event.query().insertAndFetch(event);
      if (event.lectureId) {
        await EventChanges.query().insert({
          param: "created",
          lectureId: result.lectureId,
          eventId: result.id,
          new: result.title
        });
      }

      return result;
    }

    // Hvis eventet eksisterer, og ikke har ændret sig.
    return exists;
  } catch (error) {
    console.error(error);
  }
};

const insertTeachers = async (
  event: Partial<Event>,
  teachers: Teacher[],
  result: Event
) => {
  try {
    // Find undervisere i eventet
    const eventTeachers: Teacher[] = [];
    for (let teacher of teachers) {
      if (
        event.description &&
        event.description.toLowerCase().includes(teacher.name.toLowerCase())
      ) {
        eventTeachers.push(teacher);
      }
    }

    // Hent de joins der allerede eksisterer for eventet
    const teacherJoins = await EventsTeachers.query().where({
      eventId: result.id
    });

    /* Tjek for om antallet af undervisere har ændret sig siden sidste opdatering.
  Hvis det har, så slet alle, og sæt dem ind igen. */
    if (
      eventTeachers.length > 0 &&
      teacherJoins.length !== eventTeachers.length
    ) {
      await EventsTeachers.query()
        .where({ eventId: result.id })
        .delete();

      for (let teacher of eventTeachers) {
        const exists = await EventsTeachers.query()
          .where({ eventId: result.id, teacherId: teacher.id })
          .first();
        if (exists) continue;

        await EventsTeachers.query().insert({
          eventId: result.id,
          teacherId: teacher.id
        });
      }
    }
  } catch (error) {
    console.error(error);
  }
};

const insertEventsAndTeachers = async (events: any[]) => {
  try {
    // Insert events into database
    let count = 1;
    for (let event of events) {
      if (process.env.NODE_ENV !== "production") {
        console.log(`Parsing event ${count} of ${events.length}`);
      }

      const { lectureId, title, description, semester, year, season } = event;
      const team = event.team;
      delete event.team; // Vi fjerner team fra selve event objectet, da dette ikke skal indgå under events i databasen

      // Indsæt eventet i events, hvis det ikke allerede eksisterer
      let existsQuery = Event.query();
      // Sammenlign med forelæsningsID - hvis dette ikke eksiterer så sammenlign Titel, ellers så indsæt
      if (lectureId) {
        existsQuery = existsQuery.where({ lectureId });
      } else {
        existsQuery = existsQuery.where({ title, description });
      }

      const exists = await existsQuery.andWhere({ semester }).first();

      const result = await compareEvents(event, exists);
      if (!result) continue;

      if (lectureId) {
        await TeamsEvents.query()
          .where({ lectureId: result.lectureId, team })
          .delete();
        await TeamsEvents.query().insert({
          lectureId,
          team,
          season,
          year,
          semester
        });
      } else {
        const joinExists = await OtherEventsTeams.query().findOne({
          eventId: result.id,
          team
        });
        if (!joinExists) {
          await OtherEventsTeams.query().insert({
            eventId: result.id,
            team
          });
        }
      }

      // Fjern alle undervisere, og sæt dem ind igen (i tilfælde af at flere undervisere er tilføjet til databasen, eller at nogen har ændret sig)
      const teachers = await Teacher.query();
      await insertTeachers(event, teachers, result);
      count++;
    }
    return "Done!";
  } catch (error) {
    console.error(error);
  }
};

const parseEvents = async (semester: number, team: number) => {
  if (process.env.NODE_ENV !== "production") {
    console.log(`Parsing semester ${semester} and team ${team}`);
  }
  const year = calculateYear();
  const season = calculateSeason();
  const zeroTeam = appendZero(team.toString());
  const link = `http://skemahealthau.dk/skema/${season}${year}_0${semester -
    6}semHold${zeroTeam}.ics`;

  // Creates the event object from ical
  let events: any[] = [];
  const getEventsFromIcal = async () =>
    new Promise((resolve, reject) => {
      ical.fromURL(link, {}, (err, data) => {
        for (let k in data) {
          if (data.hasOwnProperty(k)) {
            if (data[k].type == "VEVENT") {
              const event = data[k];
              event.title = event.summary;

              events.push({
                start: moment(event.start)
                  .tz("Europe/Copenhagen", true)
                  .toDate(),
                end: moment(event.end)
                  .tz("Europe/Copenhagen", true)
                  .toDate(),
                description: event.description,
                location: event.location,
                title: event.title,
                semester: semester,
                type: getTypeFromEvent(event),
                lectureId: getEventId(event, semester),
                year: year,
                season: season,
                team: team,
                location_id: getLocationId(event)
              });
            }
          }
        }
        return resolve("Success");
      });
    });

  await getEventsFromIcal();

  return events;
};

const deleteRemovedEvents = async (events: Partial<Event>[]) => {
  try {
    console.log("Removing leftover events...");
    if (events.length < 500) {
      return console.log("Too few events to delete. Stopping...");
    }
    const eventTitles = events.map(event => event.title || "");
    const eventDescriptions = events.map(event => event.description || "");

    const year = calculateYear();
    const season = calculateSeason();
    const deleted = await Event.query()
      .where({ season, year })
      .andWhere(function() {
        this.whereNotIn("title", eventTitles).orWhereNotIn(
          "description",
          eventDescriptions
        );
      });

    for (let deletion of deleted) {
      if (deletion.lectureId) {
        await EventChanges.query().insert({
          eventId: deletion.id,
          lectureId: deletion.lectureId,
          param: "deleted",
          old: deletion.title
        });
      }
    }

    await Event.query()
      .findByIds(deleted.map(deletion => deletion.id))
      .delete();
  } catch (error) {
    console.error(error);
  }
};

export const populateEvents = async () => {
  try {
    console.log("Running population...");
    let events: Partial<Event>[] = [];

    for (let key in semesters) {
      const teams = [...Array(semesters[key])];

      for (let [i] of teams.entries()) {
        const fetchedEvents: Partial<Event>[] = await parseEvents(
          Number(key),
          i + 1
        );
        events.push(...fetchedEvents);
      }
    }

    if (events.length < 1000) {
      console.error("Ikke nok events til at fuldføre population");
      return setTimeout(() => {
        populateEvents();
      }, 1000 * 60 * 60);
    }

    await insertEventsAndTeachers(events);
    await deleteRemovedEvents(events);

    console.log("Finished!");
  } catch (error) {
    console.error(error);
  }
};

const populateEventsCron = new CronJob("0 0 6 * * *", () => {
  console.log("Running cron job...");
  populateEvents();
});

export default populateEventsCron;
